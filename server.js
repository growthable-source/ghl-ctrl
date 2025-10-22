// server.js - Multi-Location Version with Supabase Integration, Image Upload, and Stripe Subscriptions
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { createGHLClient } = require('./lib/ghlClient');
const {
  buildOAuthCredential,
  decodeLocationCredentials,
  encodeLocationCredentials,
  getLocationAccessToken,
  sanitizeCredentialsForClient,
  isAccessTokenExpired,
  sanitizeSocialProfiles
} = require('./lib/locationCredentials');
const { refreshOAuthCredential } = require('./lib/ghlOAuth');

const VOICE_AI_API_VERSION = '2021-04-15';
const GHL_OAUTH_AUTHORIZE_URL =
  process.env.GHL_OAUTH_AUTHORIZE_URL ||
  'https://marketplace.leadconnectorhq.com/oauth/chooselocation';
const GHL_OAUTH_TOKEN_URL =
  process.env.GHL_OAUTH_TOKEN_URL ||
  'https://services.leadconnectorhq.com/oauth/token';
const GHL_OAUTH_CLIENT_ID = process.env.GHL_OAUTH_CLIENT_ID || '';
const GHL_OAUTH_CLIENT_SECRET = process.env.GHL_OAUTH_CLIENT_SECRET || '';
const GHL_OAUTH_VERSION_ID = process.env.GHL_OAUTH_VERSION_ID || '';
const DEFAULT_OAUTH_SCOPES =
  process.env.GHL_OAUTH_SCOPES ||
  [
    'contacts.readonly',
    'opportunities.readonly',
    'businesses.readonly',
    'locations/customValues.readonly',
    'locations/customValues.write',
    'locations/customFields.readonly',
    'locations/customFields.write',
    'locations/tags.readonly',
    'locations/tags.write',
    'medias.readonly',
    'medias.write',
    'links.readonly',
    'links.write',
    'socialplanner/oauth.readonly'
  ].join(' ');
const { supabaseAdmin, uploadWizardFile, signWizardFile, uploadBuilderAsset } = require('./lib/storage');
const { enqueueWizardSync } = require('./jobs/syncWizard');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class WizardConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WizardConfigError';
  }
}

const hasSupabaseAdmin = Boolean(supabaseAdmin);
function assertWizardBackend() {
  if (!supabaseAdmin) {
    throw new WizardConfigError('Onboarding wizard backend not configured');
  }
}


const app = express();
const PORT = process.env.PORT || 3000;
// Trust first proxy so secure cookies work behind Render's load balancer
app.set('trust proxy', 1);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://yltdxkkqfnhqpgqtobwu.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'your-anon-key-here'
);

// Pricing configuration
const PRICING_PLANS = {
  free: { max_locations: 4, price: 0, priceId: null },
  starter: { max_locations: 10, price: 12.99, priceId: process.env.STRIPE_STARTER_PRICE_ID },
  growth: { max_locations: 50, price: 24.99, priceId: process.env.STRIPE_GROWTH_PRICE_ID },
  scale: { max_locations: 250, price: 59.99, priceId: process.env.STRIPE_SCALE_PRICE_ID },
  enterprise: { max_locations: 999, price: 99.00, priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID }
};
const PLAN_ORDER = ['free', 'starter', 'growth', 'scale', 'enterprise'];
const PLAN_DISPLAY_NAMES = {
  free: 'Free Plan',
  starter: 'Starter Plan',
  growth: 'Growth Plan',
  scale: 'Scale Plan',
  enterprise: 'Enterprise Plan'
};
const REFERRAL_MILESTONES = [
  { count: 1, plan: 'starter', levelKey: 'insider', levelName: 'Insider', icon: '🌟' },
  { count: 3, plan: 'growth', levelKey: 'ambassador', levelName: 'Ambassador', icon: '🚀' },
  { count: 5, plan: 'scale', levelKey: 'legend', levelName: 'Legend', icon: '👑' }
];

// Create uploads directory
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'image-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only image files are allowed (PNG, JPG, GIF, WEBP)'));
    }
});

// In-memory storage for locations (in production, use a database)
const userLocations = {};

function generateReferralCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    const index = crypto.randomInt(0, alphabet.length);
    code += alphabet[index];
  }
  return code;
}

function buildEphemeralReferralRecord(userId) {
  const base = typeof userId === 'string' && userId.length > 0 ? userId : JSON.stringify(userId || '');
  let hashed;
  try {
    hashed = crypto.createHash('sha1').update(base).digest('hex').slice(0, 10).toUpperCase();
  } catch (error) {
    hashed = generateReferralCode(10);
  }
  return {
    user_id: userId,
    referral_code: hashed,
    created_at: new Date().toISOString(),
    ephemeral: true
  };
}

function calculateUnlockedPlan(paidReferrals = 0) {
  for (let i = REFERRAL_MILESTONES.length - 1; i >= 0; i -= 1) {
    if (paidReferrals >= REFERRAL_MILESTONES[i].count) {
      return REFERRAL_MILESTONES[i].plan;
    }
  }
  return null;
}

function mapReferralMilestones(paidReferrals = 0) {
  return REFERRAL_MILESTONES.map((milestone) => {
    const unlocked = paidReferrals >= milestone.count;
    return {
      count: milestone.count,
      plan: milestone.plan,
      label: PLAN_DISPLAY_NAMES[milestone.plan] || milestone.plan,
      unlocked,
      remaining: unlocked ? 0 : milestone.count - paidReferrals,
      levelKey: milestone.levelKey,
      levelName: milestone.levelName,
      icon: milestone.icon,
      levelIndex: REFERRAL_MILESTONES.indexOf(milestone) + 1
    };
  });
}

function getCurrentReferralLevel(paidReferrals = 0) {
  let currentLevel = null;
  for (let i = 0; i < REFERRAL_MILESTONES.length; i += 1) {
    const milestone = REFERRAL_MILESTONES[i];
    if (paidReferrals >= milestone.count) {
      currentLevel = {
        levelKey: milestone.levelKey,
        levelName: milestone.levelName,
        icon: milestone.icon,
        count: milestone.count,
        levelIndex: i + 1
      };
    } else {
      break;
    }
  }
  return currentLevel;
}

function getNextReferralLevel(paidReferrals = 0) {
  for (let i = 0; i < REFERRAL_MILESTONES.length; i += 1) {
    const milestone = REFERRAL_MILESTONES[i];
    if (paidReferrals < milestone.count) {
      return {
        levelKey: milestone.levelKey,
        levelName: milestone.levelName,
        icon: milestone.icon,
        count: milestone.count,
        remaining: milestone.count - paidReferrals,
        levelIndex: i + 1
      };
    }
  }
  return null;
}

function isPaidReferralStatus(status) {
  if (!status) return false;
  const normalized = String(status).toLowerCase();
  return ['paid', 'active', 'converted', 'completed', 'qualified'].includes(normalized);
}

async function ensureReferralRecord(userId) {
  if (!userId) {
    throw new Error('Missing user id for referral record');
  }

  const { data, error } = await supabase
    .from('user_referrals')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (!error && data) {
    return { ...data, ephemeral: Boolean(data.ephemeral) };
  }

  if (error) {
    if (error.code === '42P01') {
      console.warn('user_referrals table missing; returning fallback referral code');
      return buildEphemeralReferralRecord(userId);
    }
    if (error.code && error.code !== 'PGRST116') {
      console.warn('Unable to read user_referrals; falling back to ephemeral code', error);
      return buildEphemeralReferralRecord(userId);
    }
  }

  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    const referralCode = generateReferralCode();
    const { data: inserted, error: insertError } = await supabase
      .from('user_referrals')
      .insert({
        user_id: userId,
        referral_code: referralCode,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (!insertError && inserted) {
      return { ...inserted, ephemeral: false };
    }

    if (insertError) {
      if (insertError.code === '42P01') {
        console.warn('user_referrals table missing on insert; using fallback referral code');
        return buildEphemeralReferralRecord(userId);
      }
      if (insertError.code !== '23505') {
        console.warn('Unable to insert into user_referrals; using fallback code', insertError);
        return buildEphemeralReferralRecord(userId);
      }
    }
  }

  return buildEphemeralReferralRecord(userId);
}

async function fetchOrCreateSubscription(userId) {
  let subscription = null;
  let tableMissing = false;
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === '42P01') {
      tableMissing = true;
      console.warn('subscriptions table missing; using fallback free plan');
    } else if (error.code === 'PGRST116') {
      // no rows, handled below
    } else {
      console.warn('Unable to fetch subscription; falling back to free plan', error);
      return {
        user_id: userId,
        plan_type: 'free',
        status: 'active',
        max_locations: PRICING_PLANS.free.max_locations,
        fallback: true
      };
    }
  }

  if (tableMissing) {
    return {
      user_id: userId,
      plan_type: 'free',
      status: 'active',
      max_locations: PRICING_PLANS.free.max_locations,
      tableMissing: true,
      fallback: true
    };
  }

  if (data) {
    subscription = data;
  } else {
    const { data: newSubscription, error: insertError } = await supabase
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan_type: 'free',
        status: 'active',
        max_locations: PRICING_PLANS.free.max_locations,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      if (insertError.code === '42P01') {
        console.warn('subscriptions table missing on insert; using fallback free plan');
        return {
          user_id: userId,
          plan_type: 'free',
          status: 'active',
          max_locations: PRICING_PLANS.free.max_locations,
          tableMissing: true,
          fallback: true
        };
      }
      console.warn('Unable to create subscription; using fallback free plan', insertError);
      return {
        user_id: userId,
        plan_type: 'free',
        status: 'active',
        max_locations: PRICING_PLANS.free.max_locations,
        fallback: true
      };
    }

    subscription = newSubscription;
  }

  return subscription;
}

async function getReferralStats(userId) {
  const stats = {
    totalReferrals: 0,
    paidReferrals: 0,
    pendingReferrals: 0
  };

  const { data, error } = await supabase
    .from('referral_signups')
    .select('status')
    .eq('referrer_id', userId);

  if (error) {
    if (error.code === 'PGRST116') {
      return stats;
    }
    if (error.code === '42P01') {
      console.warn('Referral signups table is missing. Skipping referral stats fetch.');
      return stats;
    }
    console.warn('Unable to load referral stats; returning defaults', error);
    return stats;
  }

  const referrals = data || [];
  stats.totalReferrals = referrals.length;
  stats.paidReferrals = referrals.filter((row) => isPaidReferralStatus(row.status)).length;
  stats.pendingReferrals = Math.max(0, stats.totalReferrals - stats.paidReferrals);

  return stats;
}

async function applyReferralUpgrade(userId, paidReferrals, existingSubscription) {
  const subscription = existingSubscription || (await fetchOrCreateSubscription(userId));
  if (subscription?.tableMissing || subscription?.fallback) {
    return {
      unlockedPlan: null,
      planUpdated: false,
      subscription
    };
  }
  const unlockedPlan = calculateUnlockedPlan(paidReferrals);
  const currentPlan = subscription?.plan_type || 'free';
  let planUpdated = false;

  if (unlockedPlan && PLAN_ORDER.indexOf(unlockedPlan) > PLAN_ORDER.indexOf(currentPlan)) {
    const { error: upgradeError } = await supabase
      .from('subscriptions')
      .update({
        plan_type: unlockedPlan,
        status: 'active',
        max_locations: PRICING_PLANS[unlockedPlan].max_locations,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (upgradeError) {
      console.warn('Failed to apply referral upgrade; continuing without error', upgradeError);
    } else {
      planUpdated = true;
      subscription.plan_type = unlockedPlan;
      subscription.status = 'active';
      subscription.max_locations = PRICING_PLANS[unlockedPlan].max_locations;
    }
  }

  return {
    unlockedPlan,
    planUpdated,
    subscription
  };
}

function buildReferralLink(req, code) {
  const fallback = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
  let baseUrl = process.env.REFERRAL_BASE_URL || process.env.APP_URL || fallback;

  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `https://${baseUrl}`;
  }

  const url = new URL(baseUrl);
  url.searchParams.set('ref', code);
  return url.toString();
}

function resolveBaseUrl(req) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  if (req && typeof req.protocol === 'string') {
    const host = req.get?.('host');
    if (host) {
      return `${req.protocol}://${host}`.replace(/\/$/, '');
    }
  }
  return `http://localhost:${PORT}`;
}

function resolveOAuthRedirectUri(req) {
  if (process.env.GHL_OAUTH_REDIRECT_URI) {
    return process.env.GHL_OAUTH_REDIRECT_URI;
  }
  return `${resolveBaseUrl(req)}/oauth/leadconnector/callback`;
}

function normalizeScopes(scopes) {
  if (!scopes) return [];
  if (Array.isArray(scopes)) {
    return scopes.map((scope) => scope.trim()).filter(Boolean);
  }
  return String(scopes)
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function generateLocationRecordId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function deriveLocationStorageKey(credentialsOrRaw, fallbackLocationId = null) {
  const credentials = decodeLocationCredentials(credentialsOrRaw);
  if (credentials.scopeLevel === 'agency') {
    if (credentials.providerAccountId) {
      return `agency:${credentials.providerAccountId}`;
    }
    if (fallbackLocationId) {
      return `agency:${fallbackLocationId}`;
    }
    return `agency:${generateLocationRecordId()}`;
  }
  return credentials.providerLocationId || fallbackLocationId || null;
}

function mapSavedLocationRow(row) {
  const credentials = decodeLocationCredentials(row.token);
  return {
    id: row.id,
    name: row.name || row.ghl_name || row.location_id || 'Connected Location',
    locationId: row.location_id,
    token: getLocationAccessToken(credentials),
    credentials,
    ghlName: row.ghl_name,
    email: row.email,
    addedAt: row.added_at,
    lastUsed: row.last_used
  };
}

function toSafeLocation(location) {
  return {
    ...location,
    token: '***',
    credentials: sanitizeCredentialsForClient(location.credentials)
  };
}

function replaceUserLocations(userId, locations) {
  userLocations[userId] = locations;
}

function upsertUserLocationCache(userId, location) {
  if (!userLocations[userId]) {
    userLocations[userId] = [];
  }
  const index = userLocations[userId].findIndex(
    (loc) =>
      loc.id === location.id ||
      (loc.locationId && location.locationId && loc.locationId === location.locationId)
  );
  if (index >= 0) {
    userLocations[userId][index] = location;
  } else {
    userLocations[userId].push(location);
  }
}

async function fetchOAuthInstallationProfile(credential) {
  try {
    const client = createGHLClient(credential);
    if (credential.scopeLevel === 'location' && credential.providerLocationId) {
      const businessId =
        credential.providerLocationId ||
        credential.metadata?.businessId ||
        credential.metadata?.providerLocationId;
      if (businessId) {
        try {
          const { data } = await client.get('/businesses/', {
            params: { locationId: businessId }
          });
          const businessList = data?.businesses || data || [];
          const business = Array.isArray(businessList)
            ? businessList[0]
            : businessList?.business || businessList;
          const businessName =
            business?.name ||
            business?.businessName ||
            business?.companyName ||
            business?.title ||
            null;
          return {
            name: businessName || `Location ${businessId}`,
            email: business?.email || null,
            ghlName: businessName || null,
            locationId: business?.locationId || credential.providerLocationId,
            businessId: business?.id || businessId,
            phone: business?.phone || null,
            website: business?.website || null,
            address: business?.address || null
          };
        } catch (businessError) {
          console.warn(
            'Failed to load HighLevel business profile, falling back to location lookup',
            businessError.response?.data || businessError.message
          );
        }
      }
      const { data } = await client.get(`/locations/${credential.providerLocationId}`);
      const location = data?.location || data;
      const locationName =
        location?.name ||
        location?.companyName ||
        location?.businessName ||
        location?.title ||
        null;
      return {
        name: locationName || `Location ${credential.providerLocationId}`,
        email: location?.email || null,
        ghlName: locationName || null,
        locationId: credential.providerLocationId,
        businessId: credential.providerLocationId
      };
    }
    if (credential.scopeLevel === 'agency') {
      const { data } = await client.get('/users/current');
      const agencyName = data?.companyName || data?.name || 'Agency Account';
      return {
        name: agencyName,
        email: data?.email || null,
        ghlName: agencyName,
        locationId: credential.providerAccountId
          ? `agency:${credential.providerAccountId}`
          : null
      };
    }
  } catch (error) {
    console.warn(
      'Failed to load installation profile from GoHighLevel',
      error.response?.data || error.message
    );
  }
  return {
    name: credential.scopeLevel === 'agency' ? 'Agency Account' : 'Connected Location',
    email: null,
    ghlName: null,
    locationId: credential.providerLocationId || null
  };
}

async function upsertOAuthLocationRecord({ userId, credential, profile = {} }) {
  const effectiveCredential = { ...credential };

  if (!effectiveCredential.providerLocationId && profile.locationId) {
    effectiveCredential.providerLocationId =
      effectiveCredential.scopeLevel === 'agency'
        ? null
        : profile.locationId;
  }
  if (profile.businessId) {
    effectiveCredential.metadata = {
      ...(effectiveCredential.metadata || {}),
      businessId: profile.businessId
    };
  }
  if (!effectiveCredential.providerAccountId && credential.scopeLevel === 'agency') {
    effectiveCredential.providerAccountId =
      profile.locationId && profile.locationId.startsWith('agency:')
        ? profile.locationId.replace('agency:', '')
        : effectiveCredential.providerAccountId || null;
  }

  const storageKey = deriveLocationStorageKey(
    effectiveCredential,
    profile.locationId || null
  );
  const nowIso = new Date().toISOString();

  const baseRecord = {
    user_id: userId,
    location_id: storageKey,
    name:
      profile.name ||
      (effectiveCredential.scopeLevel === 'agency'
        ? 'Agency Account'
        : 'Connected Location'),
    token: encodeLocationCredentials(effectiveCredential),
    ghl_name: profile.ghlName || profile.name || null,
    email: profile.email || null,
    added_at: nowIso,
    last_used: null
  };

  const { data: existing, error: existingError } = await supabase
    .from('saved_locations')
    .select('id, added_at')
    .eq('user_id', userId)
    .eq('location_id', storageKey)
    .maybeSingle();

  if (existingError && existingError.code !== 'PGRST116') {
    throw existingError;
  }

  if (existing) {
    const updatePayload = {
      name: baseRecord.name,
      token: baseRecord.token,
      ghl_name: baseRecord.ghl_name,
      email: baseRecord.email,
      last_used: baseRecord.last_used
    };
    const { error: updateError } = await supabase
      .from('saved_locations')
      .update(updatePayload)
      .eq('id', existing.id)
      .eq('user_id', userId);
    if (updateError) {
      throw updateError;
    }
    return {
      id: existing.id,
      ...baseRecord,
      added_at: existing.added_at || baseRecord.added_at
    };
  }

  const id = generateLocationRecordId();
  const insertPayload = {
    ...baseRecord,
    id
  };
  const { error: insertError } = await supabase
    .from('saved_locations')
    .insert(insertPayload);
  if (insertError) {
    throw insertError;
  }
  return insertPayload;
}

function appendQueryParam(url, key, value) {
  if (!value && value !== 0) return url;
  const [base, hash] = String(url).split('#');
  const separator = base.includes('?') ? '&' : '?';
  const updated = `${base}${separator}${encodeURIComponent(key)}=${encodeURIComponent(
    value
  )}`;
  return hash ? `${updated}#${hash}` : updated;
}

function streamToString(stream) {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}

function needsProfileRefresh(location) {
  if (!location) return false;
  const currentName = (location.ghlName || location.name || '').trim();
  if (!currentName) return true;
  if (/^connected location$/i.test(currentName)) return true;
  if (currentName === location.locationId) return true;
  if (/^location\s+/i.test(currentName)) return true;
  return false;
}

async function enrichLocationProfile(userId, location) {
  if (!location || location.credentials?.type !== 'oauth') {
    return location;
  }
  if (!needsProfileRefresh(location)) {
    return location;
  }
  try {
    const credentialForLookup = {
      ...location.credentials,
      providerLocationId:
        location.credentials?.providerLocationId || location.locationId,
      metadata: {
        ...(location.credentials?.metadata || {}),
        providerLocationId:
          location.credentials?.metadata?.providerLocationId || location.locationId
      }
    };
    const profile = await fetchOAuthInstallationProfile(credentialForLookup);
    if (!profile) {
      return location;
    }
    const updatedName = profile.name || profile.ghlName || location.name;
    const updatedGhlName = profile.ghlName || profile.name || updatedName;
    const updatedEmail = profile.email || location.email || null;
    const mergedCredentials = {
      ...location.credentials,
      providerLocationId:
        credentialForLookup.providerLocationId || location.credentials?.providerLocationId,
      metadata: {
        ...(location.credentials?.metadata || {}),
        ...(profile.businessId ? { businessId: profile.businessId } : {})
      }
    };
    const updatePayload = {
      name: updatedName || location.name,
      ghl_name: updatedGhlName || location.ghlName,
      email: updatedEmail
    };
    try {
      await supabase
        .from('saved_locations')
        .update({
          ...updatePayload,
          token: encodeLocationCredentials(mergedCredentials)
        })
        .eq('id', location.id)
        .eq('user_id', userId);
    } catch (persistError) {
      console.warn('Failed to persist location profile', persistError);
    }
    const merged = {
      ...location,
      name: updatePayload.name,
      ghlName: updatePayload.ghl_name,
      email: updatePayload.email,
      credentials: mergedCredentials
    };
    upsertUserLocationCache(userId, merged);
    return merged;
  } catch (error) {
    console.warn('HighLevel profile enrichment failed', error.response?.data || error.message);
    return location;
  }
}

function buildSocialProfileRecord(platform, accountId, payload = {}, details = {}) {
  const account = details.account || details || {};
  const locations = details.locations || [];
  const displayName =
    account.displayName ||
    account.businessName ||
    account.name ||
    payload?.accountName ||
    accountId;
  return {
    platform,
    accountId,
    displayName,
    placement: payload?.placement || null,
    reconnectAccounts: Array.isArray(payload?.reconnectAccounts)
      ? payload.reconnectAccounts
      : [],
    locations,
    connectedAt: new Date().toISOString()
  };
}

async function maybeRefreshLocationCredential(userId, location) {
  if (
    !location ||
    !location.credentials ||
    location.credentials.type !== 'oauth'
  ) {
    return location;
  }
  const credentials = location.credentials;
  const needsRefresh =
    isAccessTokenExpired(credentials, 180) ||
    !location.token ||
    location.token === '***';
  if (!needsRefresh) {
    return location;
  }
  if (!credentials.refreshToken) {
    return location;
  }
  if (!GHL_OAUTH_CLIENT_ID || !GHL_OAUTH_CLIENT_SECRET) {
    console.warn(
      'Skipping HighLevel token refresh - client credentials not configured'
    );
    return location;
  }
  try {
    const refreshed = await refreshOAuthCredential(credentials, {
      clientId: GHL_OAUTH_CLIENT_ID,
      clientSecret: GHL_OAUTH_CLIENT_SECRET,
      tokenUrl: GHL_OAUTH_TOKEN_URL
    });
    const mergedCredentials = {
      ...credentials,
      ...refreshed,
      refreshToken: refreshed.refreshToken || credentials.refreshToken,
      metadata: {
        ...(credentials.metadata || {}),
        ...(refreshed.metadata || {})
      },
      providerAccountId:
        refreshed.providerAccountId ||
        credentials.providerAccountId ||
        null,
      providerLocationId:
        refreshed.providerLocationId ||
        credentials.providerLocationId ||
        null,
      installedAt: refreshed.installedAt || credentials.installedAt
    };
    const updated = {
      ...location,
      token: getLocationAccessToken(mergedCredentials),
      credentials: mergedCredentials,
      lastUsed: new Date().toISOString()
    };
    try {
      await supabase
        .from('saved_locations')
        .update({
          token: encodeLocationCredentials(mergedCredentials),
          last_used: updated.lastUsed
        })
        .eq('id', location.id)
        .eq('user_id', userId);
    } catch (dbError) {
      console.error('Failed to persist refreshed HighLevel credential', dbError);
    }
    upsertUserLocationCache(userId, updated);
    return updated;
  } catch (error) {
    console.error('Failed to refresh HighLevel OAuth credential', {
      locationId: location.locationId,
      error: error.response?.data || error.message
    });
    return location;
  }
}

// IMPORTANT: Stripe webhook MUST come before express.json() middleware
// because it needs the raw body
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata.user_id;
        const planType = session.metadata.plan_type;
        
        await supabase
          .from('subscriptions')
          .update({
            stripe_subscription_id: session.subscription,
            plan_type: planType,
            status: 'active',
            max_locations: PRICING_PLANS[planType].max_locations,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId);
        
        console.log('✓ Subscription activated:', userId, planType);
        break;
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        
        await supabase
          .from('subscriptions')
          .update({
            status: subscription.status,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscription.id);
        
        console.log('✓ Subscription updated:', subscription.id);
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        
        // Downgrade to free
        await supabase
          .from('subscriptions')
          .update({
            plan_type: 'free',
            status: 'canceled',
            max_locations: 4,
            stripe_subscription_id: null,
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscription.id);
        
        console.log('✓ Subscription canceled, downgraded to free:', subscription.id);
        break;
      }
      
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        
        await supabase
          .from('subscriptions')
          .update({
            status: 'past_due',
            updated_at: new Date().toISOString()
          })
          .eq('stripe_customer_id', invoice.customer);
        
        console.log('✗ Payment failed:', invoice.customer);
        break;
      }
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// Middleware (placed AFTER webhook endpoint)
app.use(cors({
  origin: process.env.APP_URL || `http://localhost:${PORT}`,
  credentials: true
}));
app.use(express.json());

const fileUpload = require('express-fileupload');
app.use(fileUpload({
  limits: { fileSize: 25 * 1024 * 1024 },
}));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const user = {
        id: profile.id,
        displayName: profile.displayName,
        email: profile.emails[0].value,
        photo: profile.photos[0].value,
        authType: 'google'
      };
      
      // Initialize user's locations array if not exists
      if (!userLocations[user.id]) {
        userLocations[user.id] = [];
      }
      
      return done(null, user);
    } catch (error) {
      console.error('Google OAuth error:', error);
      return done(error);
    }
  }
));

// Authentication middleware
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ 
    success: false, 
    error: 'Authentication required',
    loginUrl: '/auth/google'
  });
};

const WIZARD_FLAG_KEY = 'onboarding_wizard_enabled';

async function isWizardEnabled(orgUserId) {
  if (process.env.ONBOARDING_WIZARD_FORCE_ENABLE === 'true') {
    return true;
  }
  if (!hasSupabaseAdmin) {
    return process.env.FEATURE_FLAG_FALLBACK_ONBOARDING === 'true';
  }
  if (!orgUserId) {
    return false;
  }
  const ownerId = getWizardOwnerId(orgUserId);
  if (!ownerId) {
    return false;
  }
  const { data, error } = await supabaseAdmin
    .from('feature_flags')
    .select('enabled')
    .eq('org_user_id', ownerId)
    .eq('key', WIZARD_FLAG_KEY)
    .maybeSingle();
  if (error) {
    console.error('feature flag lookup failed', error);
    return false;
  }
  return !!data?.enabled;
}

function requireWizardEnabled(handler) {
  return async (req, res, next) => {
    try {
      const orgUserId = req.user?.id;
      if (!(await isWizardEnabled(orgUserId))) {
        return res.status(403).json({ success: false, error: 'Onboarding wizard disabled' });
      }
      return handler(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

const WIZARD_SCHEMA_VERSION = 2;

const DEFAULT_THEME = {
  logoUrl: '',
  logoStorageKey: '',
  logoFit: 'contain',
  logoWidth: '',
  logoHeight: '',
  primaryColor: '#4f46e5',
  accentColor: '#6366f1',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  showProgress: true,
  fontFamily: 'Inter'
};

function coerceString(value, fallback = '') {
  if (value == null) return fallback;
  return String(value);
}

function isUuid(value) {
  if (typeof value !== 'string') return false;
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  return uuidRegex.test(value.trim());
}

function getWizardOwnerId(userId) {
  const raw = coerceString(userId).trim();
  if (!raw) return null;
  if (isUuid(raw)) return raw;
  const hash = crypto.createHash('sha1').update(`wizard:${raw}`).digest('hex');
  const part1 = hash.slice(0, 8);
  const part2 = hash.slice(8, 12);
  const part3 = ((parseInt(hash.slice(12, 16), 16) & 0x0fff) | 0x5000)
    .toString(16)
    .padStart(4, '0');
  const part4 = ((parseInt(hash.slice(16, 20), 16) & 0x3fff) | 0x8000)
    .toString(16)
    .padStart(4, '0');
  const part5 = hash.slice(20, 32).padEnd(12, '0');
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

function sanitizeBlockInput(block = {}, index = 0) {
  const id =
    coerceString(block.id).trim() || `block_${index}_${crypto.randomUUID()}`;
  const type = coerceString(block.type, 'text');
  return {
    id,
    type,
    title: coerceString(block.title, 'Block'),
    helperText: coerceString(block.helperText, ''),
    required: type === 'text' ? false : Boolean(block.required),
    mode: block.mode === 'create' ? 'create' : 'existing',
    referenceId: block.referenceId ? coerceString(block.referenceId) : null,
    newEntity:
      block.newEntity && typeof block.newEntity === 'object'
        ? block.newEntity
        : {},
    layout:
      block.layout && typeof block.layout === 'object'
        ? block.layout
        : { width: 'full' },
    settings:
      block.settings && typeof block.settings === 'object'
        ? block.settings
        : {},
    content:
      type === 'text'
        ? coerceString(block.content, 'Add instructions here…')
        : coerceString(block.content || ''),
    textVariant:
      type === 'text'
        ? coerceString(block.textVariant, 'paragraph') || 'paragraph'
        : null
  };
}

function sanitizePageInput(page = {}, index = 0) {
  const id =
    coerceString(page.id).trim() || `page_${index}_${crypto.randomUUID()}`;
  const blocks = Array.isArray(page.blocks)
    ? page.blocks.map((block, idx) => sanitizeBlockInput(block, idx))
    : [];
  return {
    id,
    title: coerceString(page.title, `Page ${index + 1}`),
    description: coerceString(page.description, ''),
    layout: coerceString(page.layout, 'single'),
    blocks
  };
}

function sanitizeTheme(theme = {}) {
  return {
    ...DEFAULT_THEME,
    ...(typeof theme === 'object' ? theme : {})
  };
}

function sanitizeTemplateInput(template = {}, { ownerId }) {
  if (!template || typeof template !== 'object') {
    throw new Error('Template payload required');
  }
  const pages = Array.isArray(template.pages)
    ? template.pages.map((page, idx) => sanitizePageInput(page, idx))
    : [];
  const locationIdRaw =
    template.locationId != null ? coerceString(template.locationId) : '';
  const theme = sanitizeTheme(template.theme);
  const sanitized = {
    name: coerceString(template.name, 'Untitled Wizard').slice(0, 140),
    description: coerceString(template.description, ''),
    status: template.status || 'draft',
    locationId: locationIdRaw,
    theme,
    definition: {
      version: template.metadata?.version || WIZARD_SCHEMA_VERSION,
      pages,
      theme,
      metadata: {
        ...(template.metadata || {}),
        locationId: locationIdRaw
      }
    },
    created_by: ownerId
  };
  return sanitized;
}

function mapTemplateRow(row) {
  if (!row) return null;
  const definition = row.definition || row.steps || {};
  const pages = Array.isArray(definition.pages)
    ? definition.pages
    : Array.isArray(definition)
      ? definition
      : [];
  const metadata = definition.metadata || {};
  const locationIdValue =
    metadata.locationId || definition.locationId || row.location_id || null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    status: row.status || 'draft',
    locationId: locationIdValue,
    theme: sanitizeTheme(row.theme || definition.theme || {}),
    pages,
    metadata: {
      version: definition.version || WIZARD_SCHEMA_VERSION,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      locationId: locationIdValue
    }
  };
}

function mapWizardResponses(rows) {
  const map = {};
  (rows || []).forEach((row) => {
    if (!row) return;
    map[row.step_key] = {
      id: row.id,
      idx: row.idx,
      blocks: row.payload?.blocks || {},
      meta: row.payload?.meta || {},
      uploadedFiles: row.uploaded_files || [],
      completedAt: row.completed_at || null
    };
  });
  return map;
}

function mapWizardRecord(row) {
  if (!row) return null;
  const templateMeta = row.template?.definition?.metadata || {};
  const templateLegacyMeta = row.template?.metadata || {};
  const locationExternalId =
    templateMeta.locationId ||
    templateLegacyMeta.locationId ||
    row.location_id ||
    null;
  return {
    id: row.id,
    templateId: row.template_id,
    org_user_id: row.org_user_id,
    location_id: row.location_id,
    locationId: locationExternalId,
    status: row.status,
    submitted_at: row.submitted_at,
    template: mapTemplateRow(row.template),
    responses: mapWizardResponses(row.steps)
  };
}

function sanitizeBlockResponses(page, blocksInput = {}, existing = {}) {
  const result = {};
  if (!page || !Array.isArray(page.blocks)) {
    return result;
  }
  page.blocks.forEach((block) => {
    const incoming = blocksInput[block.id];
    const prior = existing[block.id] || {};
    if (incoming === undefined && prior) {
      result[block.id] = prior;
      return;
    }
    const value = incoming?.value ?? prior.value ?? null;
    const uploads = Array.isArray(incoming?.uploads)
      ? incoming.uploads
      : Array.isArray(prior.uploads)
        ? prior.uploads
        : [];
    const meta =
      incoming?.meta && typeof incoming.meta === 'object'
        ? incoming.meta
        : prior.meta || {};
    result[block.id] = {
      value,
      uploads,
      meta
    };
  });
  return result;
}

async function listTemplatesWithStats(ownerId, orgUserId) {
  const { data: templates, error } = await supabaseAdmin
    .from('onboarding_templates')
    .select('*')
    .eq('created_by', ownerId)
    .order('updated_at', { ascending: false });
  if (error) throw error;

  const templateIds = (templates || []).map((tpl) => tpl.id).filter(Boolean);
  const wizardMap = new Map();
  const wizardOwnerId = orgUserId ? getWizardOwnerId(orgUserId) : null;

  if (templateIds.length && wizardOwnerId) {
    const { data: wizards, error: wizardError } = await supabaseAdmin
      .from('onboarding_wizards')
      .select('id, template_id, status, submitted_at, public_token, created_at')
      .in('template_id', templateIds)
      .eq('org_user_id', wizardOwnerId);
    if (wizardError) throw wizardError;
    (wizards || []).forEach((wizard) => {
      const list = wizardMap.get(wizard.template_id) || [];
      list.push(wizard);
      wizardMap.set(wizard.template_id, list);
    });
  }

  const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;

  return (templates || []).map((row) => {
    const mapped = mapTemplateRow(row);
    const related = wizardMap.get(row.id) || [];
    const issuedCount = related.length;
    const submitted = related.filter((item) => item.submitted_at);
    const submittedCount = submitted.length;

    const latestWizard = related.reduce((latest, current) => {
      if (!latest) return current;
      return new Date(current.created_at) > new Date(latest.created_at)
        ? current
        : latest;
    }, null);

    const latestSubmission = submitted.reduce((latest, current) => {
      if (!latest) return current;
      return new Date(current.submitted_at) > new Date(latest.submitted_at)
        ? current
        : latest;
    }, null);

    return {
      ...mapped,
      stats: {
        issuedCount,
        submittedCount,
        lastIssuedAt: latestWizard?.created_at || null,
        lastSubmittedAt: latestSubmission?.submitted_at || null,
        latestPublicUrl: latestWizard
          ? `${baseUrl}/onboard.html?token=${latestWizard.public_token}`
          : null
      }
    };
  });
}

async function findUserLocation(userId, locationId) {
  if (!userId || !locationId) return null;
  let cached = userLocations[userId]?.find(
    (loc) => loc.id === locationId || loc.locationId === locationId
  );
  if (cached) {
    cached = await maybeRefreshLocationCredential(userId, cached);
    cached = await enrichLocationProfile(userId, cached);
    if (cached && cached.token && cached.token !== '***') {
      return {
        id: cached.id,
        name: cached.name,
        locationId: cached.locationId,
        token: cached.token,
        credentials: cached.credentials
      };
    }
  }

  let builder = supabaseAdmin
    .from('saved_locations')
    .select('id, name, location_id, token')
    .eq('user_id', userId);

  if (isUuid(locationId)) {
    builder = builder.eq('id', locationId);
  } else {
    builder = builder.eq('location_id', locationId);
  }

  const { data, error } = await builder
    .order('added_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  const mapped = mapSavedLocationRow(data);
  const refreshed = await maybeRefreshLocationCredential(userId, mapped);
  const enriched = await enrichLocationProfile(userId, refreshed);
  return {
    id: enriched.id,
    name: enriched.name,
    locationId: enriched.locationId,
    token: enriched.token,
    credentials: enriched.credentials
  };
}

async function findLocationForOrgUser(orgUserId, locationId) {
  const candidates = [];
  const trimmed = coerceString(orgUserId).trim();
  if (trimmed) {
    candidates.push(trimmed);
    const owner = getWizardOwnerId(trimmed);
    if (owner && owner !== trimmed) {
      candidates.push(owner);
    }
  }
  for (const candidate of candidates) {
    try {
      const location = await findUserLocation(candidate, locationId);
      if (location) return location;
    } catch (error) {
      continue;
    }
  }
  return null;
}

async function issueWizardLinkRecord(userId, templateId, locationId) {
  const token = crypto.randomBytes(24).toString('hex');
  const rawLocationId = locationId ? String(locationId).trim() : null;
  const orgUserId = getWizardOwnerId(userId);
  if (!orgUserId) {
    throw new Error('Unable to resolve wizard owner');
  }
  const { data, error } = await supabaseAdmin
    .from('onboarding_wizards')
    .insert({
      template_id: templateId,
      org_user_id: orgUserId,
      location_id: rawLocationId,
      public_token: token
    })
    .select('id, public_token')
    .single();
  if (error) throw error;
  const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  return {
    wizardId: data.id,
    publicUrl: `${baseUrl}/onboard.html?token=${data.public_token}`
  };
}

// Helper function to check if user can add more locations
async function canAddLocation(userId) {
  try {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('max_locations, status, plan_type')
      .eq('user_id', userId)
      .single();
    
    if (!subscription || subscription.status !== 'active') {
      return { canAdd: false, reason: 'No active subscription' };
    }
    
    const { data: locations } = await supabase
      .from('saved_locations')
      .select('id')
      .eq('user_id', userId);
    
    const currentCount = locations?.length || 0;
    
    if (currentCount >= subscription.max_locations) {
      return {
        canAdd: false,
        reason: 'Location limit reached',
        current: currentCount,
        max: subscription.max_locations,
        planType: subscription.plan_type
      };
    }
    
    return { 
      canAdd: true, 
      current: currentCount, 
      max: subscription.max_locations,
      planType: subscription.plan_type
    };
  } catch (error) {
    console.error('Error checking location limit:', error);
    return { canAdd: false, reason: 'Error checking limit' };
  }
}

// Serve static files from public directory
app.use(express.static('public'));

// Authentication Routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'Logout failed' });
    }
    res.redirect('/login.html');
  });
});

app.get('/oauth/leadconnector/start', ensureAuthenticated, (req, res) => {
  if (!GHL_OAUTH_CLIENT_ID || !GHL_OAUTH_CLIENT_SECRET) {
    return res.status(500).json({
      success: false,
      error: 'HighLevel OAuth credentials are not configured.'
    });
  }

  const requestedScopes = normalizeScopes(req.query.scope);
  const defaultScopes = normalizeScopes(DEFAULT_OAUTH_SCOPES);
  const scopes = (requestedScopes.length ? requestedScopes : defaultScopes).join(' ');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = resolveOAuthRedirectUri(req);
  const returnTo =
    typeof req.query.returnTo === 'string' && req.query.returnTo
      ? req.query.returnTo
      : '/';

  req.session.ghlOAuthState = state;
  req.session.ghlOAuthReturnTo = returnTo;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GHL_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: scopes,
    state
  });
  if (GHL_OAUTH_VERSION_ID) {
    params.set('version_id', GHL_OAUTH_VERSION_ID);
  }

  res.redirect(`${GHL_OAUTH_AUTHORIZE_URL}?${params.toString()}`);
});

app.get('/oauth/leadconnector/callback', ensureAuthenticated, async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const returnTo = req.session.ghlOAuthReturnTo || '/';

  if (error) {
    console.warn('HighLevel OAuth returned error', error, errorDescription);
    delete req.session.ghlOAuthState;
    delete req.session.ghlOAuthReturnTo;
    return res.redirect(appendQueryParam(returnTo, 'oauth', error));
  }

  if (!state || state !== req.session.ghlOAuthState) {
    console.warn('HighLevel OAuth state mismatch', {
      expected: req.session.ghlOAuthState,
      received: state
    });
    delete req.session.ghlOAuthState;
    delete req.session.ghlOAuthReturnTo;
    return res.redirect(appendQueryParam(returnTo, 'oauth', 'state_mismatch'));
  }

  if (!code) {
    console.warn('HighLevel OAuth callback missing authorization code');
    delete req.session.ghlOAuthState;
    delete req.session.ghlOAuthReturnTo;
    return res.redirect(appendQueryParam(returnTo, 'oauth', 'missing_code'));
  }

  delete req.session.ghlOAuthState;

  if (!GHL_OAUTH_CLIENT_ID || !GHL_OAUTH_CLIENT_SECRET) {
    console.error('HighLevel OAuth callback invoked without client configuration');
    delete req.session.ghlOAuthReturnTo;
    return res.redirect(appendQueryParam(returnTo, 'oauth', 'config_missing'));
  }

  try {
    const redirectUri = resolveOAuthRedirectUri(req);
    const payload = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GHL_OAUTH_CLIENT_ID,
      client_secret: GHL_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code
    });

    const tokenResponse = await axios.post(GHL_OAUTH_TOKEN_URL, payload.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const tokenData = tokenResponse.data || {};
    const credential = buildOAuthCredential(tokenData, {
      metadata: {
        providerAccountId: tokenData.companyId || null,
        providerLocationId: tokenData.locationId || null,
        installationId: tokenData.installationId || null,
        scope: normalizeScopes(tokenData.scope)
      }
    });

    const profile = await fetchOAuthInstallationProfile(credential);
    const savedRecord = await upsertOAuthLocationRecord({
      userId: req.user.id,
      credential,
      profile
    });

    const cachedLocation = mapSavedLocationRow(savedRecord);
    upsertUserLocationCache(req.user.id, cachedLocation);

    const successUrl = appendQueryParam(returnTo, 'oauth', 'success');
    res.redirect(successUrl);
  } catch (exchangeError) {
    console.error(
      'HighLevel OAuth exchange failed',
      exchangeError.response?.data || exchangeError.message
    );
    const failureUrl = appendQueryParam(returnTo, 'oauth', 'exchange_failed');
    res.redirect(failureUrl);
  } finally {
    delete req.session.ghlOAuthReturnTo;
  }
});

// Supabase Auth - Email/Password Registration
app.post('/auth/register', async (req, res) => {
  const { email, password, displayName } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email and password are required'
    });
  }
  
  if (password.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 8 characters'
    });
  }
  
  try {
    // Use Supabase Auth to create user
    const { data, error } = await supabase.auth.signUp({
      email: email.toLowerCase(),
      password: password,
      options: {
        data: {
          display_name: displayName || email.split('@')[0]
        }
      }
    });
    
    if (error) {
      console.error('Supabase registration error:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Registration failed'
      });
    }
    
    // Also create entry in your users table
    if (data.user) {
      await supabase
        .from('users')
        .insert({
          id: data.user.id,
          email: email.toLowerCase(),
          display_name: displayName || email.split('@')[0],
          created_at: new Date().toISOString()
        });
    }
    
    res.json({
      success: true,
      message: 'Account created successfully. You can now login.'
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});

// Supabase Auth - Email/Password Login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email and password are required'
    });
  }
  
  try {
    // Use Supabase Auth to sign in
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase(),
      password: password
    });
    
    if (error) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }
    
    // Get user data from your users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();
    
    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', data.user.id);
    
    // Create session user object
    const userObj = {
      id: data.user.id,
      email: data.user.email,
      displayName: userData?.display_name || data.user.email.split('@')[0],
      photo: userData?.photo_url || '',
      authType: 'email'
    };
    
    // Log them into Express session
    req.logIn(userObj, (err) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: 'Login failed'
        });
      }
      
      // Initialize locations
      if (!userLocations[userObj.id]) {
        userLocations[userObj.id] = [];
      }
      
      return res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: userObj.id,
          email: userObj.email,
          displayName: userObj.displayName
        }
      });
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// Get current user info
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      success: true,
      user: req.user
    });
  } else {
    res.json({
      success: false,
      user: null
    });
  }
});

// ============================================
// SUBSCRIPTION & BILLING ENDPOINTS
// ============================================

// Get current user's subscription status
app.get('/api/subscription', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      throw error;
    }
    
    // If no subscription exists, create free tier
    if (!subscription) {
      const { data: newSub } = await supabase
        .from('subscriptions')
        .insert({
          user_id: userId,
          plan_type: 'free',
          status: 'active',
          max_locations: 4
        })
        .select()
        .single();
      
      return res.json({
        success: true,
        subscription: newSub,
        plans: PRICING_PLANS
      });
    }
    
    res.json({
      success: true,
      subscription,
      plans: PRICING_PLANS
    });
    
  } catch (error) {
    console.error('Failed to fetch subscription:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch subscription'
    });
  }
});

app.get('/api/referrals', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;

  try {
    const referralRecord = await ensureReferralRecord(userId);
    const [subscription, stats] = await Promise.all([
      fetchOrCreateSubscription(userId),
      getReferralStats(userId)
    ]);
    const rewardResult = await applyReferralUpgrade(userId, stats.paidReferrals, subscription);
    const milestones = mapReferralMilestones(stats.paidReferrals);
    const nextMilestone = milestones.find((item) => !item.unlocked) || null;
    const currentLevel = getCurrentReferralLevel(stats.paidReferrals);
    const nextLevel = getNextReferralLevel(stats.paidReferrals);
    const referralsDisabled = Boolean(referralRecord?.ephemeral);
    const shareMessage = referralsDisabled
      ? 'Referral rewards are almost ready. We will activate tracking for your account shortly.'
      : 'Invite a fellow agency owner to unlock complimentary upgrades.';
    const rewardHeadline = referralsDisabled
      ? 'Referral rewards launching soon.'
      : rewardResult.unlockedPlan
        ? `You have unlocked the ${PLAN_DISPLAY_NAMES[rewardResult.unlockedPlan]}.`
        : 'Unlock complimentary upgrades with paid referrals.';

    res.json({
      success: true,
      referral: {
        code: referralRecord.referral_code,
        link: buildReferralLink(req, referralRecord.referral_code),
        totalReferrals: stats.totalReferrals,
        paidReferrals: stats.paidReferrals,
        pendingReferrals: stats.pendingReferrals,
        milestones,
        unlockedPlan: rewardResult.unlockedPlan,
        subscriptionPlan: rewardResult.subscription?.plan_type || 'free',
        planUpdated: rewardResult.planUpdated,
        nextMilestone,
        shareMessage,
        rewardHeadline,
        remainingToNext: nextMilestone ? nextMilestone.remaining : 0,
        disabled: referralsDisabled,
        programStatus: referralsDisabled ? 'prelaunch' : 'active',
        currentLevel,
        nextLevel
      }
    });
  } catch (error) {
    console.error('Failed to load referral info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load referral information'
    });
  }
});

// Create Stripe checkout session
app.post('/api/create-checkout-session', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { planType } = req.body;
  
  if (!PRICING_PLANS[planType] || planType === 'free') {
    return res.status(400).json({
      success: false,
      error: 'Invalid plan type'
    });
  }
  
  try {
    // Get or create Stripe customer
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();
    
    let customerId = subscription?.stripe_customer_id;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: {
          user_id: userId
        }
      });
      customerId = customer.id;
      
      // Save customer ID
      await supabase
        .from('subscriptions')
        .update({ stripe_customer_id: customerId })
        .eq('user_id', userId);
    }
    
    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [
        {
          price: PRICING_PLANS[planType].priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.APP_URL || `http://localhost:${PORT}`}?success=true`,
      cancel_url: `${process.env.APP_URL || `http://localhost:${PORT}`}?canceled=true`,
      metadata: {
        user_id: userId,
        plan_type: planType
      }
    });
    
    res.json({
      success: true,
      url: session.url
    });
    
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create customer portal session
app.post('/api/create-portal-session', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();
    
    if (!subscription?.stripe_customer_id) {
      return res.status(400).json({
        success: false,
        error: 'No Stripe customer found'
      });
    }
    
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: process.env.APP_URL || `http://localhost:${PORT}`,
    });
    
    res.json({
      success: true,
      url: session.url
    });
    
  } catch (error) {
    console.error('Portal session error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// LOCATION MANAGEMENT ENDPOINTS
// ============================================

// Get all locations for current user - LOAD FROM SUPABASE
app.get('/api/locations', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  
  try {
    // Load locations from Supabase
    const { data, error } = await supabase
      .from('saved_locations')
      .select('*')
      .eq('user_id', userId)
      .order('added_at', { ascending: false });
    
    if (!error && data) {
      const uniqueByKey = new Map();
      data.forEach((row) => {
        const key =
          deriveLocationStorageKey(row.token, row.location_id) ||
          row.location_id ||
          row.id;
        if (!uniqueByKey.has(key)) {
          uniqueByKey.set(key, row);
        }
      });

      const uniqueRows = Array.from(uniqueByKey.values());
      const mappedLocations = uniqueRows.map(mapSavedLocationRow);
      const enrichedLocations = await Promise.all(
        mappedLocations.map((location) => enrichLocationProfile(userId, location))
      );
      replaceUserLocations(userId, enrichedLocations);

      const sanitizedLocations = enrichedLocations.map(toSafeLocation);

      res.json({
        success: true,
        locations: sanitizedLocations
      });
    } else {
      res.json({
        success: true,
        locations: []
      });
    }
  } catch (err) {
    console.error('Failed to load locations:', err);
    res.json({
      success: true,
      locations: []
    });
  }
});

// Add a new location (WITH SUBSCRIPTION LIMIT CHECK)
app.post('/api/locations', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { name, locationId, token } = req.body;
  
  if (!name || !locationId || !token) {
    // Check if location already exists for this user
const existingLocation = userLocations[userId]?.find(loc => loc.locationId === locationId);
if (existingLocation) {
  return res.status(400).json({
    success: false,
    error: 'This location is already added. Please use a different location or remove the existing one first.'
  });
}
    return res.status(400).json({
      success: false,
      error: 'Name, locationId, and token are required'
    });

  }
  
  
  // Check if user can add more locations
  const limitCheck = await canAddLocation(userId);
  if (!limitCheck.canAdd) {
    return res.status(403).json({
      success: false,
      error: limitCheck.reason,
      needsUpgrade: true,
      current: limitCheck.current,
      max: limitCheck.max,
      planType: limitCheck.planType
    });
  }
  
  // Test the connection
  try {
    const client = createGHLClient(token);
    const response = await client.get(`/locations/${locationId}`);
    
    // Get location details
    const locationData = response.data?.location || response.data;
    
    // Create location object
    const credentials = {
      type: 'private_token',
      accessToken: token,
      scopeLevel: 'location',
      providerLocationId: locationId
    };
    const newLocation = {
      id: Date.now().toString(),
      name: name,
      locationId: locationId,
      token: token,
      credentials,
      ghlName: locationData?.name || locationData?.companyName || name,
      email: locationData?.email || '',
      addedAt: new Date().toISOString(),
      lastUsed: null
    };
    
    // Add to user's locations
    upsertUserLocationCache(userId, newLocation);
    
    // SAVE TO SUPABASE FOR PERSISTENCE
    try {
      await supabase
        .from('saved_locations')
        .insert({
          id: newLocation.id,
          user_id: userId,
          name: newLocation.name,
          location_id: newLocation.locationId,
          token: encodeLocationCredentials(credentials),
          ghl_name: newLocation.ghlName,
          email: newLocation.email,
          added_at: newLocation.addedAt,
          last_used: newLocation.lastUsed
        });
    } catch (dbError) {
      console.error('Failed to save location to database:', dbError);
    }
    
    await initializeSupabaseTables(locationId);
    
    const safeLocation = toSafeLocation(newLocation);
    res.json({ success: true, location: safeLocation });
  } catch (error) {
    console.error('Failed to verify location:', error.response?.data || error.message);
    res.status(400).json({
      success: false,
      error: 'Failed to verify location credentials. Please check your token and location ID.'
    });
  }
});

async function initializeSupabaseTables(locationId) {
  try {
    const { data, error } = await supabase
      .from('location_sync_status')
      .upsert({
        location_id: locationId,
        last_sync: new Date().toISOString(),
        status: 'active'
      }, {
        onConflict: 'location_id'
      });
    
    if (error) {
      console.error('Failed to initialize Supabase tables:', error);
    }
  } catch (error) {
    console.error('Supabase initialization error:', error);
  }
}

// Update a location
app.put('/api/locations/:id', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  const { name, token } = req.body;
  
  if (!userLocations[userId]) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const locationIndex = userLocations[userId].findIndex(loc => loc.id === locationId);
  if (locationIndex === -1) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  if (name) userLocations[userId][locationIndex].name = name;
  if (token) {
    try {
      const client = createGHLClient(token);
      await client.get(`/locations/${userLocations[userId][locationIndex].locationId}`);
      const existingScopeLevel =
        userLocations[userId][locationIndex].credentials?.scopeLevel || 'location';
      const providerLocationId =
        userLocations[userId][locationIndex].credentials?.providerLocationId ||
        userLocations[userId][locationIndex].locationId;
      const credentials = {
        type: 'private_token',
        accessToken: token,
        scopeLevel: existingScopeLevel,
        providerLocationId
      };
      userLocations[userId][locationIndex].token = token;
      userLocations[userId][locationIndex].credentials = credentials;
      try {
        await supabase
          .from('saved_locations')
          .update({ token: encodeLocationCredentials(credentials) })
          .eq('id', locationId)
          .eq('user_id', userId);
      } catch (dbError) {
        console.error('Failed to update location credentials in database:', dbError);
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token provided'
      });
    }
  }
  
  const updatedLocation = userLocations[userId][locationIndex];
  
  res.json({
    success: true,
    location: toSafeLocation(updatedLocation)
  });
});

// Delete a location - ALSO DELETE FROM SUPABASE
app.delete('/api/locations/:id', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  
  if (!userLocations[userId]) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const locationIndex = userLocations[userId].findIndex(loc => loc.id === locationId);
  if (locationIndex === -1) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const [removedLocation] = userLocations[userId].splice(locationIndex, 1);
  
  try {
    const supabaseClient = supabaseAdmin || supabase;
    if (supabaseClient) {
      await supabaseClient
        .from('saved_locations')
        .delete()
        .eq('id', locationId)
        .eq('user_id', userId);
      if (removedLocation?.locationId) {
        await supabaseClient
          .from('saved_locations')
          .delete()
          .eq('location_id', removedLocation.locationId)
          .eq('user_id', userId);
      }
    }
  } catch (dbError) {
    console.error('Failed to delete from database:', dbError);
  }
  
  res.json({
    success: true,
    message: 'Location removed successfully'
  });
});

// Test connection for a specific location
app.post('/api/test-location', ensureAuthenticated, async (req, res) => {
  const { locationId, token } = req.body;
  
  if (!locationId || !token) {
    return res.status(400).json({
      success: false,
      error: 'locationId and token are required'
    });
  }
  
  try {
    const client = createGHLClient(token);
    const response = await client.get(`/locations/${locationId}`);
    
    const locationData = response.data?.location || response.data;
    
    res.json({
      success: true,
      message: 'Connection successful',
      location: {
        name: locationData?.name || locationData?.companyName || 'Location accessible',
        id: locationData?.id || locationData?._id || locationId,
        email: locationData?.email
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.response?.data?.message || 'Connection failed',
      details: error.response?.data
    });
  }
});

// CUSTOM FIELDS ENDPOINTS

app.get('/api/locations/:locationId/custom-fields', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const response = await client.get(`/locations/${location.locationId}/customFields`);
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customFields: response.data.customFields || response.data || [],
      count: (response.data.customFields || response.data || []).length
    });
  } catch (error) {
    console.error('Failed to fetch custom fields:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.post('/api/locations/:locationId/custom-fields', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const { name, dataType, placeholder, position, model } = req.body;
  
  if (!name || !dataType) {
    return res.status(400).json({
      success: false,
      error: 'Name and dataType are required fields'
    });
  }
  
  const allowedDataTypes = ['TEXT', 'TEXTBOX_LIST', 'NUMBER', 'PHONE', 'MONETARYAMOUNT', 
                            'CHECKBOX', 'DROPDOWN', 'RADIO', 'DATE'];
  if (!allowedDataTypes.includes(dataType)) {
    return res.status(400).json({
      success: false,
      error: `Invalid dataType. Must be one of: ${allowedDataTypes.join(', ')}`
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const payload = {
      name,
      dataType,
      placeholder: placeholder || '',
      position: position || 0,
      model: model || 'contact'
    };
    
    const response = await client.post(`/locations/${location.locationId}/customFields`, payload);
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customField: response.data.customField,
      message: 'Custom field created successfully'
    });
  } catch (error) {
    console.error('Failed to create custom field:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.put('/api/locations/:locationId/custom-fields/:fieldId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, fieldId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const response = await client.put(
      `/locations/${location.locationId}/customFields/${fieldId}`,
      req.body
    );
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customField: response.data.customField,
      message: 'Custom field updated successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.delete('/api/locations/:locationId/custom-fields/:fieldId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, fieldId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    await client.delete(`/locations/${location.locationId}/customFields/${fieldId}`);
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      message: 'Custom field deleted successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// CLONE/COPY ENDPOINTS

// Clone custom fields from one location to another
app.post('/api/locations/:sourceId/clone-fields', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { sourceId } = req.params;
  const { targetLocationIds, fieldIds } = req.body;
  
  if (!targetLocationIds || !Array.isArray(targetLocationIds) || targetLocationIds.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Target location IDs are required'
    });
  }
  
  const sourceLocation = userLocations[userId]?.find(loc => loc.id === sourceId);
  if (!sourceLocation) {
    return res.status(404).json({
      success: false,
      error: 'Source location not found'
    });
  }
  
  try {
    // Get fields from source location
    const sourceClient = createGHLClient(sourceLocation.token);
    const sourceResponse = await sourceClient.get(`/locations/${sourceLocation.locationId}/customFields`);
    let fieldsToClone = sourceResponse.data.customFields || [];
    
    // Filter to specific fields if provided
    if (fieldIds && fieldIds.length > 0) {
      fieldsToClone = fieldsToClone.filter(f => fieldIds.includes(f.id));
    }
    
    const results = {
      success: 0,
      failed: 0,
      details: [],
      locationResults: {}
    };
    
    // Clone to each target location
    for (const targetId of targetLocationIds) {
      const targetLocation = userLocations[userId]?.find(loc => loc.id === targetId);
      if (!targetLocation) {
        results.failed++;
        results.details.push({
          locationId: targetId,
          locationName: 'Unknown Location',
          error: 'Target location not found',
          itemName: 'N/A'
        });
        continue;
      }
      
      // Initialize results for this location
      if (!results.locationResults[targetId]) {
        results.locationResults[targetId] = {
          locationId: targetId,
          locationName: targetLocation.name,
          success: 0,
          failed: 0,
          errors: []
        };
      }
      
      const targetClient = createGHLClient(targetLocation.token);
      
      for (const field of fieldsToClone) {
        try {
          const payload = {
            name: field.name,
            dataType: field.dataType,
            placeholder: field.placeholder || '',
            position: field.position || 0,
            model: field.model || 'contact'
          };
          
          await targetClient.post(`/locations/${targetLocation.locationId}/customFields`, payload);
          results.success++;
          results.locationResults[targetId].success++;
        } catch (error) {
          results.failed++;
          results.locationResults[targetId].failed++;
          
          const errorDetail = {
            locationId: targetId,
            locationName: targetLocation.name,
            itemName: field.name,
            itemType: 'field',
            error: error.response?.data?.message || error.message
          };
          
          results.details.push(errorDetail);
          results.locationResults[targetId].errors.push(errorDetail);
        }
      }
    }
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('Clone fields error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clone custom values from one location to another
app.post('/api/locations/:sourceId/clone-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { sourceId } = req.params;
  const { targetLocationIds, valueIds } = req.body;
  
  if (!targetLocationIds || !Array.isArray(targetLocationIds) || targetLocationIds.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Target location IDs are required'
    });
  }
  
  const sourceLocation = userLocations[userId]?.find(loc => loc.id === sourceId);
  if (!sourceLocation) {
    return res.status(404).json({
      success: false,
      error: 'Source location not found'
    });
  }
  
  try {
    // Get values from source location
    const sourceClient = createGHLClient(sourceLocation.token);
    const sourceResponse = await sourceClient.get(`/locations/${sourceLocation.locationId}/customValues`);
    let valuesToClone = sourceResponse.data.customValues || [];
    
    // Filter to specific values if provided
    if (valueIds && valueIds.length > 0) {
      valuesToClone = valuesToClone.filter(v => valueIds.includes(v.id));
    }
    
    const results = {
      success: 0,
      failed: 0,
      details: [],
      locationResults: {}
    };
    
    // Clone to each target location
    for (const targetId of targetLocationIds) {
      const targetLocation = userLocations[userId]?.find(loc => loc.id === targetId);
      if (!targetLocation) {
        results.failed++;
        results.details.push({
          locationId: targetId,
          locationName: 'Unknown Location',
          error: 'Target location not found',
          itemName: 'N/A'
        });
        continue;
      }
      
      // Initialize results for this location
      if (!results.locationResults[targetId]) {
        results.locationResults[targetId] = {
          locationId: targetId,
          locationName: targetLocation.name,
          success: 0,
          failed: 0,
          errors: []
        };
      }
      
      const targetClient = createGHLClient(targetLocation.token);
      
      for (const value of valuesToClone) {
        try {
          const payload = {
            name: value.name,
            value: value.value
          };
          
          await targetClient.post(`/locations/${targetLocation.locationId}/customValues`, payload);
          results.success++;
          results.locationResults[targetId].success++;
        } catch (error) {
          results.failed++;
          results.locationResults[targetId].failed++;
          
          const errorDetail = {
            locationId: targetId,
            locationName: targetLocation.name,
            itemName: value.name,
            itemType: 'value',
            error: error.response?.data?.message || error.message
          };
          
          results.details.push(errorDetail);
          results.locationResults[targetId].errors.push(errorDetail);
        }
      }
    }
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('Clone values error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// CUSTOM VALUES ENDPOINTS

async function syncCustomValues(locationId, ghlToken) {
  try {
    const client = createGHLClient(ghlToken);
    const response = await client.get(`/locations/${locationId}/customValues`);
    
    const rawValues = response.data.customValues || [];
    
    const cleanedValues = rawValues.map(item => ({
      id: item.id,
      location_id: locationId,
      name: item.name || '',
      value: item.value || '',
      field_key: item.fieldKey || '',
      document_type: item.documentType || 'field',
      parent_id: item.parentId || null,
      synced_at: new Date().toISOString()
    }));
    
    const { data, error } = await supabase
      .from('custom_values')
      .upsert(cleanedValues, {
        onConflict: 'id'
      });
    
    if (error) {
      console.error('Failed to sync to Supabase:', error);
      return { success: false, error };
    }
    
    return { success: true, data: cleanedValues };
  } catch (error) {
    console.error('Sync error:', error);
    return { success: false, error };
  }
}

app.get('/api/locations/:locationId/custom-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  const { forceSync } = req.query;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const { data: supabaseValues, error: supabaseError } = await supabase
      .from('custom_values')
      .select('*')
      .eq('location_id', location.locationId)
      .order('name', { ascending: true });
    
    if (forceSync || !supabaseValues || supabaseValues.length === 0) {
      console.log('Syncing from GoHighLevel...');
      const syncResult = await syncCustomValues(location.locationId, location.token);
      
      if (syncResult.success) {
        res.json({
          success: true,
          customValues: syncResult.data.map(v => ({
            id: v.id,
            name: v.name,
            value: v.value || '',
            fieldKey: v.field_key
          })),
          count: syncResult.data.length,
          source: 'ghl_sync'
        });
      } else {
        if (supabaseValues && supabaseValues.length > 0) {
          res.json({
            success: true,
            customValues: supabaseValues.map(v => ({
              id: v.id,
              name: v.name,
              value: v.value || '',
              fieldKey: v.field_key
            })),
            count: supabaseValues.length,
            source: 'supabase_cache'
          });
        } else {
          throw new Error('Failed to sync and no cached data available');
        }
      }
    } else {
      res.json({
        success: true,
        customValues: supabaseValues.map(v => ({
          id: v.id,
          name: v.name,
          value: v.value || '',
          fieldKey: v.field_key
        })),
        count: supabaseValues.length,
        source: 'supabase'
      });
    }
    
    location.lastUsed = new Date().toISOString();
    
  } catch (error) {
    console.error('Failed to fetch custom values:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch custom values'
    });
  }
});

app.post('/api/locations/:locationId/custom-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const { name, value } = req.body;
  
  if (!name || !value) {
    return res.status(400).json({
      success: false,
      error: 'Name and value are required fields'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const payload = { name, value };
    
    const response = await client.post(`/locations/${location.locationId}/customValues`, payload);
    const createdValue = response.data.customValue;
    
    const { data: supabaseData, error: supabaseError } = await supabase
      .from('custom_values')
      .upsert({
        id: createdValue.id,
        location_id: location.locationId,
        name: createdValue.name || name,
        value: createdValue.value || value,
        field_key: createdValue.fieldKey || '',
        document_type: 'field',
        synced_at: new Date().toISOString()
      });
    
    if (supabaseError) {
      console.error('Failed to save to Supabase:', supabaseError);
    }
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customValue: {
        id: createdValue.id,
        name: createdValue.name || name,
        value: createdValue.value || value
      },
      message: 'Custom value created successfully'
    });
  } catch (error) {
    console.error('Failed to create custom value:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.put('/api/locations/:locationId/custom-values/:valueId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, valueId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const response = await client.put(
      `/locations/${location.locationId}/customValues/${valueId}`,
      req.body
    );
    
    const { error: supabaseError } = await supabase
      .from('custom_values')
      .update({
        name: req.body.name,
        value: req.body.value,
        synced_at: new Date().toISOString()
      })
      .eq('id', valueId);
    
    if (supabaseError) {
      console.error('Failed to update Supabase:', supabaseError);
    }
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customValue: response.data.customValue,
      message: 'Custom value updated successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.delete('/api/locations/:locationId/custom-values/:valueId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, valueId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    await client.delete(`/locations/${location.locationId}/customValues/${valueId}`);
    
    const { error: supabaseError } = await supabase
      .from('custom_values')
      .delete()
      .eq('id', valueId);
    
    if (supabaseError) {
      console.error('Failed to delete from Supabase:', supabaseError);
    }
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      message: 'Custom value deleted successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.post('/api/locations/:locationId/sync-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const syncResult = await syncCustomValues(location.locationId, location.token);
    
    if (syncResult.success) {
      res.json({
        success: true,
        message: 'Values synced successfully',
        count: syncResult.data.length
      });
    } else {
      throw new Error(syncResult.error);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Sync failed: ' + error.message
    });
  }
});

// TRIGGER LINK ENDPOINTS
app.get('/api/locations/:locationId/links', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const response = await client.get('/links/', {
      params: { locationId: location.locationId }
    });
    
    const rawLinks = response.data?.links || response.data?.link || response.data || [];
    const linksArray = Array.isArray(rawLinks) ? rawLinks : [rawLinks].filter(Boolean);
    
    const triggerLinks = linksArray.map(link => ({
      id: link?.id || link?._id || link?.linkId || link?.uuid || null,
      name: link?.name || link?.linkName || '',
      slug: link?.slug || link?.identifier || '',
      redirectTo: link?.redirectTo || link?.redirectUrl || '',
      shortUrl: link?.shortUrl || link?.shortLink || '',
      fullUrl: link?.fullUrl || link?.url || '',
      createdAt: link?.createdAt || link?.created_at || null,
      updatedAt: link?.updatedAt || link?.updated_at || null
    }));
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      triggerLinks
    });
  } catch (error) {
    console.error('Failed to load trigger links:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.post('/api/locations/:locationId/links', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  const { name, redirectTo } = req.body;
  
  if (!name || !redirectTo) {
    return res.status(400).json({
      success: false,
      error: 'Name and redirect URL are required'
    });
  }
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const payload = {
      locationId: location.locationId,
      name,
      redirectTo
    };
    
    const response = await client.post('/links/', payload);
    const createdLink = response.data?.link || response.data || {};
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      triggerLink: {
        id: createdLink?.id || createdLink?._id || createdLink?.linkId || createdLink?.uuid || null,
        name: createdLink?.name || name,
        slug: createdLink?.slug || '',
        redirectTo: createdLink?.redirectTo || redirectTo,
        shortUrl: createdLink?.shortUrl || createdLink?.shortLink || '',
        fullUrl: createdLink?.fullUrl || createdLink?.url || '',
        createdAt: createdLink?.createdAt || createdLink?.created_at || new Date().toISOString()
      },
      message: 'Trigger link created successfully'
    });
  } catch (error) {
    console.error('Failed to create trigger link:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.delete('/api/locations/:locationId/links/:linkId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, linkId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    await client.delete(`/links/${linkId}`, {
      params: { locationId: location.locationId }
    });
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      message: 'Trigger link deleted successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// FIELD AUDIT ENDPOINT
// FIELD AUDIT ENDPOINT
app.post('/api/locations/:locationId/audit-fields', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  const { forceFull } = req.body; // Allow forcing full scan
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    
    // Get all custom fields
    const fieldsResponse = await client.get(`/locations/${location.locationId}/customFields`);
    const fields = fieldsResponse.data.customFields || [];
    
    if (fields.length === 0) {
      return res.json({
        success: true,
        audit: {
          totalFields: 0,
          usedFields: [],
          unusedFields: [],
          samplingUsed: false
        }
      });
    }
    
    // Get total counts first
    const contactCountRes = await client.post(`/contacts/search`, {
      locationId: location.locationId,
      pageLimit: 1
    });
    const totalContacts = contactCountRes.data.total || 0;
    
    let totalOpportunities = 0;
    try {
      const oppCountRes = await client.post(`/opportunities/search`, {
        locationId: location.locationId,
        pageLimit: 1
      });
      totalOpportunities = oppCountRes.data.total || 0;
    } catch (error) {
      console.log('No opportunities:', error.message);
    }
    
    // Determine if sampling is needed
    const SAMPLING_THRESHOLD = 500;
    const totalRecords = totalContacts + totalOpportunities;
    const useSampling = !forceFull && totalRecords > SAMPLING_THRESHOLD;
    
    let contacts = [];
    let opportunities = [];
    let recordsScanned = 0;
    
    if (useSampling) {
      // Sample approach: 10 pages of 100 = 1000 records
      const PAGES_TO_SCAN = 10;
      
      for (let page = 1; page <= PAGES_TO_SCAN && contacts.length < 1000; page++) {
        try {
          const contactsResponse = await client.post(`/contacts/search`, {
            locationId: location.locationId,
            page: page,
            pageLimit: 100
          });
          contacts.push(...(contactsResponse.data.contacts || []));
        } catch (error) {
          break;
        }
      }
      
      // Sample opportunities too
      for (let page = 1; page <= PAGES_TO_SCAN && opportunities.length < 1000; page++) {
        try {
          const oppsResponse = await client.post(`/opportunities/search`, {
            locationId: location.locationId,
            page: page,
            pageLimit: 100
          });
          opportunities.push(...(oppsResponse.data.opportunities || []));
        } catch (error) {
          break;
        }
      }
      
      recordsScanned = contacts.length + opportunities.length;
    } else {
      // Full scan for smaller datasets
      const contactsResponse = await client.post(`/contacts/search`, {
        locationId: location.locationId,
        pageLimit: 100
      });
      contacts = contactsResponse.data.contacts || [];
      
      try {
        const oppsResponse = await client.post(`/opportunities/search`, {
          locationId: location.locationId,
          pageLimit: 100
        });
        opportunities = oppsResponse.data.opportunities || [];
      } catch (error) {
        console.log('No opportunities:', error.message);
      }
      
      recordsScanned = contacts.length + opportunities.length;
    }
    
    const fieldUsage = {};
    
    // Initialize all fields
    fields.forEach(field => {
      fieldUsage[field.id] = {
        id: field.id,
        name: field.name,
        fieldKey: field.fieldKey,
        dataType: field.dataType,
        model: field.model,
        count: 0,
        percentage: 0
      };
    });
    
    // Count usage in contacts
    contacts.forEach(contact => {
      if (contact.customFields) {
        Object.keys(contact.customFields).forEach(fieldId => {
          const value = contact.customFields[fieldId];
          if (value !== null && value !== undefined && value !== '') {
            if (fieldUsage[fieldId]) {
              fieldUsage[fieldId].count++;
            }
          }
        });
      }
    });
    
    // Count usage in opportunities
    opportunities.forEach(opp => {
      if (opp.customFields) {
        Object.keys(opp.customFields).forEach(fieldId => {
          const value = opp.customFields[fieldId];
          if (value !== null && value !== undefined && value !== '') {
            if (fieldUsage[fieldId]) {
              fieldUsage[fieldId].count++;
            }
          }
        });
      }
    });
    
    // Calculate percentages
    Object.keys(fieldUsage).forEach(fieldId => {
      if (recordsScanned > 0) {
        fieldUsage[fieldId].percentage = ((fieldUsage[fieldId].count / recordsScanned) * 100).toFixed(2);
      }
    });
    
    const usedFields = Object.values(fieldUsage).filter(f => f.count > 0);
    const unusedFields = Object.values(fieldUsage).filter(f => f.count === 0);
    
    res.json({
      success: true,
      audit: {
        totalFields: fields.length,
        usedFields,
        unusedFields,
        totalContacts,
        totalOpportunities,
        totalRecords,
        recordsScanned,
        samplingUsed: useSampling,
        samplingThreshold: SAMPLING_THRESHOLD
      }
    });
    
  } catch (error) {
    console.error('Audit error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}); 

// GET LOCATION STATS
app.get('/api/locations/:locationId/stats', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  let location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  location = await enrichLocationProfile(userId, location);

  try {
    const client = createGHLClient(location.token);
    let displayName = location.ghlName || location.name;
    let businessId =
      location.credentials?.metadata?.businessId ||
      location.credentials?.providerLocationId ||
      location.locationId;
    let businessProfile = null;

    if (location.credentials?.type === 'oauth' && businessId) {
      try {
        const businessRes = await client.get('/businesses/', {
          params: { locationId: businessId }
        });
        const businessList = businessRes.data?.businesses || businessRes.data || [];
        const business = Array.isArray(businessList)
          ? businessList[0]
          : businessList?.business || businessList;
        if (business) {
          businessProfile = business;
          displayName = business.name || displayName;
          businessId = business.id || businessId;
          const updatePayload = {
            ghl_name: business.name || displayName || location.name,
            email: business.email || location.email || null
          };
          if (
            !location.name ||
            location.name === 'Connected Location' ||
            location.name === location.locationId
          ) {
            updatePayload.name = business.name || displayName || location.name;
          }
          try {
            await supabase
              .from('saved_locations')
              .update(updatePayload)
              .eq('id', location.id)
              .eq('user_id', userId);
            location = {
              ...location,
              name: updatePayload.name || location.name,
              ghlName: updatePayload.ghl_name || location.ghlName,
              email: updatePayload.email || location.email
            };
            upsertUserLocationCache(userId, location);
          } catch (updateError) {
            console.warn('Failed to persist business profile details', updateError);
          }
        }
      } catch (businessError) {
        console.warn(
          'HighLevel business lookup failed',
          businessError.response?.data || businessError.message
        );
      }
    }

    if (!displayName) {
      try {
        const locationRes = await client.get(`/locations/${location.locationId}`);
        const data = locationRes.data?.location || locationRes.data;
        displayName =
          data?.name ||
          data?.companyName ||
          `Location ${location.locationId}`;
      } catch (fallbackError) {
        console.warn(
          'HighLevel location lookup failed',
          fallbackError.response?.data || fallbackError.message
        );
        displayName = `Location ${location.locationId}`;
      }
    }

    const statsPromises = [
      client.get(`/locations/${location.locationId}/customFields`).catch((err) => err),
      client.get(`/locations/${location.locationId}/customValues`).catch((err) => err),
      client.get(`/locations/${location.locationId}/tags`).catch((err) => err),
      client
        .get('/links/', { params: { locationId: location.locationId } })
        .catch((err) => err),
      client
        .get('/medias/files', { params: { locationId: location.locationId } })
        .catch((err) => err)
    ];

    const [fieldsRes, valuesRes, tagsRes, linksRes, mediaRes] = await Promise.all(statsPromises);

    const isAxiosError = (response) =>
      response && response.isAxiosError;

    res.json({
      success: true,
      stats: {
        fieldsCount: isAxiosError(fieldsRes)
          ? 0
          : (fieldsRes.data.customFields || []).length,
        valuesCount: isAxiosError(valuesRes)
          ? 0
          : (valuesRes.data.customValues || []).length,
        tagsCount: isAxiosError(tagsRes)
          ? 0
          : (tagsRes.data?.tags || tagsRes.data || []).length,
        linksCount: isAxiosError(linksRes)
          ? 0
          : (linksRes.data?.links || linksRes.data?.data || linksRes.data || []).length,
        mediaCount: isAxiosError(mediaRes)
          ? 0
          : (mediaRes.data?.files || mediaRes.data?.data || mediaRes.data || []).length,
        connectionType: location.credentials?.type || 'private_token',
        connectionLabel:
          location.credentials?.type === 'oauth'
            ? 'HighLevel Marketplace'
            : 'Private Token',
        displayName,
        business: businessProfile
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/social/google/accounts', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const locationId = (req.query.locationId || '').trim();
  if (!locationId) {
    return res.status(400).json({ success: false, error: 'locationId is required' });
  }

  try {
    const location = await findUserLocation(userId, locationId);
    if (!location) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }
    const profiles = sanitizeSocialProfiles(location.credentials || {});
    res.json({ success: true, profiles });
  } catch (error) {
    console.error('social google accounts error', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch social profiles' });
  }
});

app.get('/api/social/google/start', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const locationId = (req.query.locationId || '').trim();
  if (!locationId) {
    return res.status(400).json({ success: false, error: 'locationId is required' });
  }

  try {
    const location = await findUserLocation(userId, locationId);
    if (!location) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }
    const client = createGHLClient(location.token);
    const oauthResponse = await client.get('/social-media-posting/oauth/google/start', {
      params: { locationId: location.locationId },
      responseType: 'stream',
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });

    let launchUrl =
      oauthResponse.headers?.location ||
      oauthResponse.headers?.Location ||
      oauthResponse.request?.res?.responseUrl ||
      null;

    if (!launchUrl) {
      try {
        const html = await streamToString(oauthResponse.data);
        const match = html.match(/https?:\/\/[\w%\-./?=&+@]+/i);
        if (match) {
          launchUrl = match[0];
        }
      } catch (parseError) {
        console.warn('Failed to parse Google OAuth response html', parseError);
      }
    } else if (oauthResponse.data?.destroy) {
      oauthResponse.data.destroy();
    }

    if (!launchUrl) {
      console.error('Unable to determine Google OAuth launch URL');
      return res.status(500).json({
        success: false,
        error: 'Unable to start Google OAuth flow'
      });
    }

    res.json({ success: true, url: launchUrl });
  } catch (error) {
    console.error('social google start failure', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to start Google connection' });
  }
});

app.post('/api/social/google/connections', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, accountId, payload } = req.body || {};
  if (!locationId || !accountId) {
    return res.status(400).json({ success: false, error: 'locationId and accountId are required' });
  }

  try {
    const location = await findUserLocation(userId, locationId);
    if (!location) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }
    const client = createGHLClient(location.token);
    let accountDetails = null;
    try {
      const response = await client.get(
        `/social-media-posting/oauth/${location.locationId}/google/locations/${accountId}`
      );
      accountDetails = response.data?.results || response.data || {};
    } catch (accountError) {
      console.warn('Failed to fetch Google account details', accountError.response?.data || accountError.message);
    }

    const profileRecord = buildSocialProfileRecord('google', accountId, payload, accountDetails);
    const credentials = location.credentials || {};
    const metadata = credentials.metadata || {};
    const social = metadata.socialProfiles || {};
    const existingList = Array.isArray(social.google) ? [...social.google] : [];
    const existingIdx = existingList.findIndex((item) => item && item.accountId === accountId);
    if (existingIdx >= 0) {
      existingList[existingIdx] = { ...existingList[existingIdx], ...profileRecord };
    } else {
      existingList.push(profileRecord);
    }
    const updatedCredentials = {
      ...credentials,
      metadata: {
        ...metadata,
        socialProfiles: {
          ...social,
          google: existingList
        }
      }
    };

    await supabase
      .from('saved_locations')
      .update({
        token: encodeLocationCredentials(updatedCredentials),
        last_used: new Date().toISOString()
      })
      .eq('id', location.id)
      .eq('user_id', userId);

    const updatedLocation = {
      ...location,
      credentials: updatedCredentials,
      token: getLocationAccessToken(updatedCredentials)
    };
    upsertUserLocationCache(userId, updatedLocation);

    res.json({
      success: true,
      profile: profileRecord,
      profiles: sanitizeSocialProfiles(updatedCredentials)
    });
  } catch (error) {
    console.error('social google connection error', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to save Google account' });
  }
});

app.delete('/api/social/google/connections/:accountId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { accountId } = req.params;
  const locationId = (req.query.locationId || '').trim();
  if (!locationId || !accountId) {
    return res.status(400).json({ success: false, error: 'locationId and accountId are required' });
  }

  try {
    const location = await findUserLocation(userId, locationId);
    if (!location) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }
    const credentials = location.credentials || {};
    const metadata = credentials.metadata || {};
    const social = metadata.socialProfiles || {};
    const googleProfiles = Array.isArray(social.google) ? social.google.filter((item) => item && item.accountId !== accountId) : [];
    const updatedCredentials = {
      ...credentials,
      metadata: {
        ...metadata,
        socialProfiles: {
          ...social,
          google: googleProfiles
        }
      }
    };

    await supabase
      .from('saved_locations')
      .update({ token: encodeLocationCredentials(updatedCredentials) })
      .eq('id', location.id)
      .eq('user_id', userId);

    const updatedLocation = {
      ...location,
      credentials: updatedCredentials,
      token: getLocationAccessToken(updatedCredentials)
    };
    upsertUserLocationCache(userId, updatedLocation);

    res.json({
      success: true,
      profiles: sanitizeSocialProfiles(updatedCredentials)
    });
  } catch (error) {
    console.error('social google remove error', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to remove Google account' });
  }
});

app.get('/edge/social/google/start', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({ success: false, error: 'token is required' });
  }

  try {
    const wizard = await fetchWizardByToken(token);
    if (!wizard) {
      return res.status(404).json({ success: false, error: 'Wizard not found' });
    }
    if (!(await isWizardEnabled(wizard.org_user_id))) {
      return res.status(403).json({ success: false, error: 'Onboarding wizard disabled' });
    }
    const wizardLocationId = wizard.locationId || wizard.location_id;
    if (!wizardLocationId) {
      return res.status(400).json({ success: false, error: 'Wizard not linked to a location' });
    }
    const location =
      (await findLocationForOrgUser(wizard.org_user_id, wizardLocationId)) ||
      (await findUserLocation(wizard.org_user_id, wizardLocationId));
    if (!location) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }
    if (location.credentials?.type !== 'oauth') {
      return res.status(400).json({ success: false, error: 'Location is not connected via OAuth' });
    }
    const client = createGHLClient(location.token);
    const oauthResponse = await client.get('/social-media-posting/oauth/google/start', {
      params: { locationId: location.locationId },
      responseType: 'stream',
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });

    let launchUrl =
      oauthResponse.headers?.location ||
      oauthResponse.headers?.Location ||
      oauthResponse.request?.res?.responseUrl ||
      null;

    if (!launchUrl) {
      try {
        const html = await streamToString(oauthResponse.data);
        const match = html.match(/https?:\/\/[\w%\-./?=&+@]+/i);
        if (match) {
          launchUrl = match[0];
        }
      } catch (parseError) {
        console.warn('Failed to parse Google OAuth response html (edge)', parseError);
      }
    } else if (oauthResponse.data?.destroy) {
      oauthResponse.data.destroy();
    }

    if (!launchUrl) {
      console.error('Unable to determine Google OAuth launch URL for edge flow');
      return res.status(500).json({ success: false, error: 'Unable to start Google OAuth flow' });
    }

    res.json({ success: true, url: launchUrl });
  } catch (error) {
    console.error('edge social google start failure', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to start Google connection' });
  }
});

app.post('/edge/social/google/connections', async (req, res) => {
  const { token, accountId, payload } = req.body || {};
  if (!token || !accountId) {
    return res.status(400).json({ success: false, error: 'token and accountId are required' });
  }

  try {
    const wizard = await fetchWizardByToken(token.trim());
    if (!wizard) {
      return res.status(404).json({ success: false, error: 'Wizard not found' });
    }
    if (!(await isWizardEnabled(wizard.org_user_id))) {
      return res.status(403).json({ success: false, error: 'Onboarding wizard disabled' });
    }
    const wizardLocationId = wizard.locationId || wizard.location_id;
    if (!wizardLocationId) {
      return res.status(400).json({ success: false, error: 'Wizard not linked to a location' });
    }
    const location =
      (await findLocationForOrgUser(wizard.org_user_id, wizardLocationId)) ||
      (await findUserLocation(wizard.org_user_id, wizardLocationId));
    if (!location) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }
    if (location.credentials?.type !== 'oauth') {
      return res.status(400).json({ success: false, error: 'Location is not connected via OAuth' });
    }
    const client = createGHLClient(location.token);
    let accountDetails = null;
    try {
      const response = await client.get(
        `/social-media-posting/oauth/${location.locationId}/google/locations/${accountId}`
      );
      accountDetails = response.data?.results || response.data || {};
    } catch (accountError) {
      console.warn('edge social google account lookup failed', accountError.response?.data || accountError.message);
    }

    const profileRecord = buildSocialProfileRecord('google', accountId, payload, accountDetails);
    const credentials = location.credentials || {};
    const metadata = credentials.metadata || {};
    const social = metadata.socialProfiles || {};
    const existing = Array.isArray(social.google) ? [...social.google] : [];
    const existingIndex = existing.findIndex((item) => item && item.accountId === accountId);
    if (existingIndex >= 0) {
      existing[existingIndex] = { ...existing[existingIndex], ...profileRecord };
    } else {
      existing.push(profileRecord);
    }
    const updatedCredentials = {
      ...credentials,
      metadata: {
        ...metadata,
        socialProfiles: {
          ...social,
          google: existing
        }
      }
    };

    await supabase
      .from('saved_locations')
      .update({
        token: encodeLocationCredentials(updatedCredentials),
        last_used: new Date().toISOString()
      })
      .eq('id', location.id)
      .eq('user_id', wizard.org_user_id);

    const updatedLocation = {
      ...location,
      credentials: updatedCredentials,
      token: getLocationAccessToken(updatedCredentials)
    };
    upsertUserLocationCache(wizard.org_user_id, updatedLocation);

    res.json({
      success: true,
      profile: profileRecord,
      profiles: sanitizeSocialProfiles(updatedCredentials)
    });
  } catch (error) {
    console.error('edge social google connection error', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to save Google account' });
  }
});

app.delete('/edge/social/google/connections/:accountId', async (req, res) => {
  const token = (req.query.token || '').trim();
  const accountId = req.params.accountId;
  if (!token || !accountId) {
    return res.status(400).json({ success: false, error: 'token and accountId are required' });
  }

  try {
    const wizard = await fetchWizardByToken(token);
    if (!wizard) {
      return res.status(404).json({ success: false, error: 'Wizard not found' });
    }
    if (!(await isWizardEnabled(wizard.org_user_id))) {
      return res.status(403).json({ success: false, error: 'Onboarding wizard disabled' });
    }
    const wizardLocationId = wizard.locationId || wizard.location_id;
    if (!wizardLocationId) {
      return res.status(400).json({ success: false, error: 'Wizard not linked to a location' });
    }
    const location =
      (await findLocationForOrgUser(wizard.org_user_id, wizardLocationId)) ||
      (await findUserLocation(wizard.org_user_id, wizardLocationId));
    if (!location) {
      return res.status(404).json({ success: false, error: 'Location not found' });
    }

    const credentials = location.credentials || {};
    const metadata = credentials.metadata || {};
    const social = metadata.socialProfiles || {};
    const googleProfiles = Array.isArray(social.google)
      ? social.google.filter((item) => item && item.accountId !== accountId)
      : [];
    const updatedCredentials = {
      ...credentials,
      metadata: {
        ...metadata,
        socialProfiles: {
          ...social,
          google: googleProfiles
        }
      }
    };

    await supabase
      .from('saved_locations')
      .update({ token: encodeLocationCredentials(updatedCredentials) })
      .eq('id', location.id)
      .eq('user_id', wizard.org_user_id);

    const updatedLocation = {
      ...location,
      credentials: updatedCredentials,
      token: getLocationAccessToken(updatedCredentials)
    };
    upsertUserLocationCache(wizard.org_user_id, updatedLocation);

    res.json({
      success: true,
      profiles: sanitizeSocialProfiles(updatedCredentials)
    });
  } catch (error) {
    console.error('edge social google remove error', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to remove Google account' });
  }
});

// MEDIA LIBRARY ENDPOINTS

// GET FILES
app.get('/api/locations/:locationId/media', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  const { limit = 100, offset = 0, query = '', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }
  
  try {
    const client = createGHLClient(location.token);
    
    const response = await client.get('/medias/files', {
      params: {
        altId: location.locationId,
        altType: 'location',
        limit,
        offset,
        query,
        type: 'file',
        sortBy,
        sortOrder
      }
    });
    
    res.json({
      success: true,
      files: response.data.files || [],
      total: response.data.total || 0
    });
  } catch (error) {
    console.error('Media fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPLOAD FILE
app.post('/api/locations/:locationId/media', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }
  
  try {
    const FormData = require('form-data');
    const form = new FormData();
    
    if (req.files && req.files.file) {
      form.append('file', req.files.file.data, req.files.file.name);
      form.append('name', req.body.name || req.files.file.name);
    } else {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }
    
    const client = createGHLClient(location.token);
    
    const uploadResponse = await client.post('/medias/upload-file', form, {
      headers: {
        ...form.getHeaders()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    
    const fileId = uploadResponse.data.fileId;
    
   const filesResponse = await client.get('/medias/files', {
  params: {
    altId: location.locationId,
    altType: 'location',
    type: 'file',
    sortBy: 'createdAt',
    sortOrder: 'desc',
    limit: '100',
    offset: '0'
  }
});
    
    const uploadedFile = filesResponse.data.files.find(f => f.id === fileId);
    
    res.json({
      success: true,
      fileId: fileId,
      url: uploadedFile ? uploadedFile.url : null
    });
  } catch (error) {
    console.error('Media upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE FILE
app.delete('/api/locations/:locationId/media/:fileId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, fileId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }
  
  try {
    const client = createGHLClient(location.token);
    
    await client.delete(`/medias/${fileId}`, {
      params: {
        altId: location.locationId,
        altType: 'location'
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Media delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/locations/:locationId/media/bulk-delete', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  const { fileIds, status } = req.body;
  const files = Array.isArray(fileIds) ? fileIds.filter(Boolean).map(String) : [];
  if (files.length === 0) {
    return res.status(400).json({ success: false, error: 'fileIds array is required' });
  }

  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }

  try {
    const client = createGHLClient(location.token);
    const payload = {
      filesToBeDeleted: files.map(id => ({ _id: id })),
      altType: 'location',
      altId: location.locationId,
      status: status === 'trashed' ? 'trashed' : 'deleted'
    };

    await client.put('/medias/delete-files', payload);

    res.json({ success: true });
  } catch (error) {
    console.error('Bulk media delete error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// TAGS ENDPOINTS
app.get('/api/locations/:locationId/tags', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;

  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }

  try {
    const client = createGHLClient(location.token);
    const response = await client.get(`/locations/${location.locationId}/tags`);
    const tags = response.data?.tags || response.data || [];

    location.lastUsed = new Date().toISOString();

    res.json({
      success: true,
      tags: Array.isArray(tags) ? tags : []
    });
  } catch (error) {
    console.error('Tags fetch error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.post('/api/locations/:locationId/tags', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  const { name } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ success: false, error: 'Tag name is required' });
  }

  const trimmedName = name.trim();
  if (!trimmedName || /\s/.test(trimmedName) || /[^a-zA-Z0-9_-]/.test(trimmedName)) {
    return res.status(400).json({
      success: false,
      error: 'Tag name may only contain letters, numbers, underscores, or hyphens with no spaces.'
    });
  }

  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }

  try {
    const client = createGHLClient(location.token);
    const response = await client.post(`/locations/${location.locationId}/tags`, { name: trimmedName });
    const created = response.data?.tag || response.data || {};

    location.lastUsed = new Date().toISOString();

    res.json({
      success: true,
      tag: created,
      message: 'Tag created successfully'
    });
  } catch (error) {
    console.error('Tag create error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.put('/api/locations/:locationId/tags/:tagId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, tagId } = req.params;
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }

  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ success: false, error: 'Tag name is required' });
  }
  const trimmedName = name.trim();
  if (!trimmedName || /\s/.test(trimmedName) || /[^a-zA-Z0-9_-]/.test(trimmedName)) {
    return res.status(400).json({
      success: false,
      error: 'Tag name may only contain letters, numbers, underscores, or hyphens with no spaces.'
    });
  }

  try {
    const client = createGHLClient(location.token);
    const response = await client.put(`/locations/${location.locationId}/tags/${tagId}`, { name: trimmedName });

    location.lastUsed = new Date().toISOString();

    res.json({
      success: true,
      tag: response.data?.tag || response.data || {},
      message: 'Tag updated successfully'
    });
  } catch (error) {
    console.error('Tag update error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.delete('/api/locations/:locationId/tags/:tagId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, tagId } = req.params;
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ success: false, error: 'Location not found' });
  }

  try {
    const client = createGHLClient(location.token);
    await client.delete(`/locations/${location.locationId}/tags/${tagId}`);

    location.lastUsed = new Date().toISOString();

    res.json({ success: true, message: 'Tag deleted successfully' });
  } catch (error) {
    console.error('Tag delete error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

async function fetchWizardByToken(token) {
  assertWizardBackend();
  const { data, error } = await supabaseAdmin
    .from('onboarding_wizards')
    .select(`
      id, template_id, org_user_id, location_id, status, submitted_at,
      template:onboarding_templates(*),
      steps:onboarding_steps(*)
    `)
    .eq('public_token', token)
    .maybeSingle();
  if (error || !data) {
    throw new Error('Wizard not found');
  }
  return mapWizardRecord(data);
}

app.get('/edge/onboard/payload', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({ success: false, error: 'token required' });
  }

  try {
    const wizard = await fetchWizardByToken(token);
    if (!(await isWizardEnabled(wizard.org_user_id))) {
      return res.status(403).json({ success: false, error: 'Onboarding wizard disabled' });
    }

    const nextStatus = wizard.status === 'draft' ? 'in_progress' : wizard.status;
    await supabaseAdmin
      .from('onboarding_wizards')
      .update({ last_opened_at: new Date().toISOString(), status: nextStatus })
      .eq('id', wizard.id);

    res.json({
      template: wizard.template,
      wizard: {
        id: wizard.id,
        status: nextStatus,
        responses: wizard.responses || {}
      }
    });
  } catch (error) {
    console.error('onboard payload error', error);
    res.status(404).json({ success: false, error: 'Wizard not found' });
  }
});

app.patch('/edge/onboard/answer', async (req, res) => {
  const { token, pageId, blocks = {}, completed } = req.body || {};
  if (!token || !pageId) {
    return res
      .status(400)
      .json({ success: false, error: 'token and pageId required' });
  }

  try {
    const wizard = await fetchWizardByToken(token);
    if (!(await isWizardEnabled(wizard.org_user_id))) {
      return res
        .status(403)
        .json({ success: false, error: 'Onboarding wizard disabled' });
    }

    const templatePages = wizard.template?.pages || [];
    const pageIdx = templatePages.findIndex((page) => page.id === pageId);
    if (pageIdx === -1) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid page id' });
    }
    const pageDefinition = templatePages[pageIdx];
    const existing = wizard.responses?.[pageId] || {};
    const sanitizedBlocks = sanitizeBlockResponses(
      pageDefinition,
      blocks,
      existing.blocks || {}
    );

    const payload = {
      blocks: sanitizedBlocks,
      meta: {
        ...(existing.meta || {}),
        updatedAt: new Date().toISOString()
      }
    };

    const isCompleted = completed === true || completed === 'true';

    const upsert = {
      wizard_id: wizard.id,
      step_key: pageId,
      idx: pageIdx,
      payload,
      uploaded_files: existing.uploadedFiles || []
    };

    if (isCompleted) {
      upsert.completed_at = new Date().toISOString();
    } else if (existing.completedAt) {
      upsert.completed_at = existing.completedAt;
    }

    const { data: stepRow, error } = await supabaseAdmin
      .from('onboarding_steps')
      .upsert(upsert, { onConflict: 'wizard_id,step_key' })
      .select('id, step_key, idx, payload, completed_at, uploaded_files')
      .single();

    if (error) throw error;

    await supabaseAdmin
      .from('onboarding_wizards')
      .update({ status: wizard.status === 'draft' ? 'in_progress' : wizard.status })
      .eq('id', wizard.id);

    res.json({
      success: true,
      page: {
        id: stepRow.step_key,
        blocks: stepRow.payload?.blocks || {},
        completedAt: stepRow.completed_at,
        uploadedFiles: stepRow.uploaded_files || []
      }
    });
  } catch (error) {
    console.error('onboard answer error', error);
    res.status(400).json({ success: false, error: 'Failed to save page' });
  }
});

app.post('/edge/onboard/upload', async (req, res) => {
  const token = req.body?.token || req.query?.token;
  const pageId = req.body?.pageId || req.query?.pageId;
  const blockId = req.body?.blockId || req.query?.blockId;
  const file = req.files?.file;
  if (!token || !pageId || !blockId || !file) {
    return res.status(400).json({
      success: false,
      error: 'token, pageId, blockId and file are required'
    });
  }

  try {
    const wizard = await fetchWizardByToken(token);
    if (!(await isWizardEnabled(wizard.org_user_id))) {
      return res
        .status(403)
        .json({ success: false, error: 'Onboarding wizard disabled' });
    }

    const templatePages = wizard.template?.pages || [];
    const pageIdx = templatePages.findIndex((page) => page.id === pageId);
    if (pageIdx === -1) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid page id' });
    }
    const pageDefinition = templatePages[pageIdx];
    const blockDefinition = pageDefinition.blocks?.find(
      (block) => block.id === blockId
    );
    if (!blockDefinition) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid block id' });
    }

    const buffer = file.data;
    const { storageKey, signedUrl } = await uploadWizardFile(
      wizard.id,
      buffer,
      file.mimetype,
      file.name
    );

    const existing = wizard.responses?.[pageId] || {};
    const sanitizedBlocks = sanitizeBlockResponses(
      pageDefinition,
      existing.blocks || {},
      existing.blocks || {}
    );

    const currentBlock = sanitizedBlocks[blockId] || {
      value: null,
      uploads: [],
      meta: {}
    };
    const uploads = Array.isArray(currentBlock.uploads)
      ? [...currentBlock.uploads]
      : [];
    const uploadMeta = {
      storageKey,
      name: file.name,
      mime: file.mimetype,
      size: file.size,
      previewUrl: signedUrl,
      uploadedAt: new Date().toISOString()
    };
    uploads.push(uploadMeta);
    sanitizedBlocks[blockId] = {
      ...currentBlock,
      uploads
    };

    const uploadedFiles = Array.isArray(existing.uploadedFiles)
      ? [...existing.uploadedFiles, uploadMeta]
      : [uploadMeta];

    const payload = {
      blocks: sanitizedBlocks,
      meta: {
        ...(existing.meta || {}),
        updatedAt: new Date().toISOString()
      }
    };

    const { data: stepRow, error } = await supabaseAdmin
      .from('onboarding_steps')
      .upsert(
        {
          wizard_id: wizard.id,
          step_key: pageId,
          idx: pageIdx,
          payload,
          uploaded_files: uploadedFiles
        },
        { onConflict: 'wizard_id,step_key' }
      )
      .select('id, step_key, idx, payload, completed_at, uploaded_files')
      .single();

    if (error) throw error;

    res.json({
      success: true,
      storageKey,
      previewUrl: signedUrl,
      name: file.name,
      mime: file.mimetype,
      size: file.size,
      page: {
        id: stepRow.step_key,
        blocks: stepRow.payload?.blocks || {},
        uploadedFiles: stepRow.uploaded_files || []
      }
    });
  } catch (error) {
    console.error('onboard upload error', error);
    res.status(400).json({ success: false, error: 'Upload failed' });
  }
});

app.post('/edge/onboard/submit', async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ success: false, error: 'token required' });
  }

  try {
    const wizard = await fetchWizardByToken(token);
    if (!(await isWizardEnabled(wizard.org_user_id))) {
      return res.status(403).json({ success: false, error: 'Onboarding wizard disabled' });
    }

    const submittedAt = new Date().toISOString();
    await supabaseAdmin
      .from('onboarding_wizards')
      .update({ status: 'submitted', submitted_at: submittedAt })
      .eq('id', wizard.id);

    enqueueWizardSync(wizard.id);

    res.json({ success: true });
  } catch (error) {
    console.error('onboard submit error', error);
    res.status(400).json({ success: false, error: 'Submit failed' });
  }
});

app.get(
  '/api/onboarding/builder/bootstrap',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const locationsResponse = await supabase
        .from('saved_locations')
        .select('id, name, location_id, ghl_name, added_at')
        .eq('user_id', req.user.id)
        .order('added_at', { ascending: false });

      const locationsMap = new Map();
      (locationsResponse.data || []).forEach((loc) => {
        const locationId = loc.location_id;
        if (!locationId || locationsMap.has(locationId)) {
          return;
        }
        locationsMap.set(locationId, {
          id: locationId,
          locationId,
          name: loc.name || loc.ghl_name || locationId,
          addedAt: loc.added_at
        });
      });
      const locations = Array.from(locationsMap.values());

      let templates = [];
      try {
        templates = await listTemplatesWithStats(ownerId, req.user.id);
      } catch (templateErr) {
        console.error('template stats error', templateErr);
      }
      const latestTemplate = templates?.[0] || null;

      res.json({
        locations,
        library: {
          customFields: [],
          customValues: [],
          triggerLinks: [],
          tags: [],
          media: [],
          socialProfiles: []
        },
        templates,
        latestTemplate
      });
    } catch (error) {
      console.error('builder bootstrap error', error);
      res.status(500).json({
        success: false,
        error: 'Failed to load builder bootstrap data'
      });
    }
  })
);

app.get(
  '/api/onboarding/builder/library',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const locationId = (req.query.locationId || '').trim();
    if (!locationId) {
      return res
        .status(400)
        .json({ success: false, error: 'locationId is required' });
    }

    try {
      const location = await findUserLocation(req.user.id, locationId);
      if (!location) {
        return res
          .status(404)
          .json({ success: false, error: 'Location not found' });
      }

      const client = createGHLClient(location.token);
      const [fields, values, tags, links, voiceAgents] = await Promise.allSettled([
        client.get(`/locations/${location.locationId}/customFields`),
        client.get(`/locations/${location.locationId}/customValues`),
        client.get(`/locations/${location.locationId}/tags`),
        client.get('/links/', { params: { locationId: location.locationId } }),
        client.get('/voice-ai/agents', {
          params: { locationId: location.locationId },
          headers: { Version: VOICE_AI_API_VERSION }
        })
      ]);

      const library = {
        customFields:
          fields.status === 'fulfilled'
            ? (fields.value.data?.customFields || []).map((item) => ({
                id: item.id,
                name: item.name,
                dataType: item.dataType,
                fieldKey: item.fieldKey
              }))
            : [],
        customValues:
          values.status === 'fulfilled'
            ? (values.value.data?.customValues || []).map((item) => ({
                id: item.id,
                name: item.name,
                value: item.value
              }))
            : [],
        tags:
          tags.status === 'fulfilled'
            ? (tags.value.data?.tags || []).map((item) => ({
                id: item.id,
                name: item.name
              }))
            : [],
        triggerLinks:
          links.status === 'fulfilled'
            ? (links.value.data?.links || []).map((item) => ({
                id: item.id,
                name: item.name,
                redirectTo: item.redirectTo
              }))
            : [],
        media: [],
        voiceAgents:
          voiceAgents.status === 'fulfilled'
            ? (() => {
                const data = voiceAgents.value.data;
                const agentsArray = Array.isArray(data?.data)
                  ? data.data
                  : Array.isArray(data?.agents)
                  ? data.agents
                  : Array.isArray(data)
                  ? data
                  : [];
                return agentsArray.map((agent, index) => ({
                  id: agent.id || agent._id || `agent-${index}`,
                  agentName: agent.agentName || agent.name || `Agent ${index + 1}`,
                  language: agent.language || 'en-US',
                  voiceId: agent.voiceId || '',
                  patienceLevel: agent.patienceLevel || 'medium'
                }));
              })()
            : [],
        socialProfiles: sanitizeSocialProfiles(location.credentials || {})
      };

      res.json({ success: true, library });
    } catch (error) {
      console.error('builder library error', error.response?.data || error);
      res.status(500).json({
        success: false,
        error: 'Failed to load location assets'
      });
    }
  })
);

app.get(
  '/api/voice-ai/agents',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const locationId = (req.query.locationId || '').trim();
    if (!locationId) {
      return res
        .status(400)
        .json({ success: false, error: 'locationId is required' });
    }
    try {
      const location = await findUserLocation(req.user.id, locationId);
      if (!location) {
        return res
          .status(404)
          .json({ success: false, error: 'Location not found' });
      }
      const client = createGHLClient(location.token);
      const response = await client.get('/voice-ai/agents', {
        params: { locationId: location.locationId },
        headers: { Version: VOICE_AI_API_VERSION }
      });
      const data = response.data;
      const agents = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.agents)
        ? data.agents
        : Array.isArray(data)
        ? data
        : [];
      res.json({ success: true, agents });
    } catch (error) {
      console.error('voice ai list error', error.response?.data || error);
      const status = error.response?.status || 500;
      res.status(status).json({
        success: false,
        error:
          error.response?.data?.message || 'Failed to load voice AI agents'
      });
    }
  })
);

app.post(
  '/api/voice-ai/agents',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const payload = req.body || {};
    const locationId = coerceString(payload.locationId).trim();
    if (!locationId) {
      return res
        .status(400)
        .json({ success: false, error: 'locationId is required' });
    }
    try {
      const location = await findUserLocation(req.user.id, locationId);
      if (!location) {
        return res
          .status(404)
          .json({ success: false, error: 'Location not found' });
      }
      const client = createGHLClient(location.token);
      const response = await client.post(
        '/voice-ai/agents',
        { ...payload, locationId: location.locationId },
        { headers: { Version: VOICE_AI_API_VERSION } }
      );
      res.status(201).json({ success: true, agent: response.data });
    } catch (error) {
      console.error('voice ai create error', error.response?.data || error);
      const status = error.response?.status || 500;
      res.status(status).json({
        success: false,
        error:
          error.response?.data?.message || 'Failed to create voice AI agent'
      });
    }
  })
);

app.put(
  '/api/voice-ai/agents/:id',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const agentId = req.params.id;
    const payload = req.body || {};
    const locationId = coerceString(payload.locationId || req.query.locationId).trim();
    if (!agentId || !locationId) {
      return res.status(400).json({
        success: false,
        error: 'agentId and locationId are required'
      });
    }
    try {
      const location = await findUserLocation(req.user.id, locationId);
      if (!location) {
        return res
          .status(404)
          .json({ success: false, error: 'Location not found' });
      }
      const client = createGHLClient(location.token);
      const response = await client.put(
        `/voice-ai/agents/${agentId}`,
        { ...payload, locationId: location.locationId },
        { headers: { Version: VOICE_AI_API_VERSION } }
      );
      res.json({ success: true, agent: response.data });
    } catch (error) {
      console.error('voice ai update error', error.response?.data || error);
      const status = error.response?.status || 500;
      res.status(status).json({
        success: false,
        error:
          error.response?.data?.message || 'Failed to update voice AI agent'
      });
    }
  })
);

app.delete(
  '/api/voice-ai/agents/:id',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const agentId = req.params.id;
    const locationId = (req.query.locationId || req.body?.locationId || '').trim();
    if (!agentId || !locationId) {
      return res
        .status(400)
        .json({ success: false, error: 'agentId and locationId are required' });
    }
    try {
      const location = await findUserLocation(req.user.id, locationId);
      if (!location) {
        return res
          .status(404)
          .json({ success: false, error: 'Location not found' });
      }
      const client = createGHLClient(location.token);
      await client.delete(`/voice-ai/agents/${agentId}`, {
        params: { locationId: location.locationId },
        headers: { Version: VOICE_AI_API_VERSION }
      });
      res.json({ success: true });
    } catch (error) {
      console.error('voice ai delete error', error.response?.data || error);
      const status = error.response?.status || 500;
      res.status(status).json({
        success: false,
        error:
          error.response?.data?.message || 'Failed to delete voice AI agent'
      });
    }
  })
);

app.post(
  '/api/onboarding/builder/logo',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const file = req.files?.file;
    if (!file) {
      return res
        .status(400)
        .json({ success: false, error: 'Logo file is required' });
    }
    try {
      const { storageKey, signedUrl } = await uploadBuilderAsset(
        'branding',
        file.data,
        file.mimetype,
        file.name
      );
      res.json({ success: true, storageKey, url: signedUrl });
    } catch (error) {
      console.error('logo upload error', error);
      res.status(400).json({ success: false, error: 'Logo upload failed' });
    }
  })
);

app.post(
  '/api/onboarding/templates',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const templatePayload = req.body?.template;
    if (!templatePayload) {
      return res
        .status(400)
        .json({ success: false, error: 'template payload required' });
    }

    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const sanitized = sanitizeTemplateInput(templatePayload, {
        ownerId
      });
      const locationIdValue = sanitized.locationId
        ? sanitized.locationId.trim()
        : '';
      let locationColumn = null;
      if (locationIdValue && isUuid(locationIdValue)) {
        locationColumn = locationIdValue;
      }
      const definitionWithMeta = {
        ...sanitized.definition,
        metadata: {
          ...(sanitized.definition.metadata || {}),
          locationId: locationIdValue
        }
      };
      const insertPayload = {
        name: sanitized.name,
        description: sanitized.description,
        status: sanitized.status,
        location_id: locationColumn,
        theme: sanitized.theme,
        definition: definitionWithMeta,
        steps: definitionWithMeta,
        created_by: ownerId
      };
      let { data, error } = await supabaseAdmin
        .from('onboarding_templates')
        .insert(insertPayload)
        .select('*')
        .single();
      if (error) {
        const fallbackPayload = {
          name: sanitized.name,
          steps: definitionWithMeta,
          created_by: ownerId
        };
        ({ data, error } = await supabaseAdmin
          .from('onboarding_templates')
          .insert(fallbackPayload)
          .select('*')
          .single());
        if (error) throw error;
      }
      res.json({ success: true, template: mapTemplateRow(data) });
    } catch (error) {
      console.error('template create error', error);
      res
        .status(400)
        .json({ success: false, error: 'Failed to save template' });
    }
  })
);

app.put(
  '/api/onboarding/templates/:id',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const templateId = req.params.id;
    const templatePayload = req.body?.template;
    if (!templatePayload) {
      return res
        .status(400)
        .json({ success: false, error: 'template payload required' });
    }

    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const sanitized = sanitizeTemplateInput(templatePayload, {
        ownerId
      });
      const locationIdValue = sanitized.locationId
        ? sanitized.locationId.trim()
        : '';
      let locationColumn = null;
      if (locationIdValue && isUuid(locationIdValue)) {
        locationColumn = locationIdValue;
      }
      const definitionWithMeta = {
        ...sanitized.definition,
        metadata: {
          ...(sanitized.definition.metadata || {}),
          locationId: locationIdValue
        }
      };
      const updatePayload = {
        name: sanitized.name,
        description: sanitized.description,
        status: sanitized.status,
        location_id: locationColumn,
        theme: sanitized.theme,
        definition: definitionWithMeta,
        steps: definitionWithMeta,
        updated_at: new Date().toISOString()
      };
      let { data, error } = await supabaseAdmin
        .from('onboarding_templates')
        .update(updatePayload)
        .eq('id', templateId)
        .eq('created_by', ownerId)
        .select('*')
        .single();
      if (error) {
        const fallbackPayload = {
          name: sanitized.name,
          steps: definitionWithMeta
        };
        ({ data, error } = await supabaseAdmin
          .from('onboarding_templates')
          .update(fallbackPayload)
          .eq('id', templateId)
          .eq('created_by', ownerId)
          .select('*')
          .single());
        if (error) throw error;
      }
      res.json({ success: true, template: mapTemplateRow(data) });
    } catch (error) {
      console.error('template update error', error);
      res
        .status(400)
        .json({ success: false, error: 'Failed to update template' });
    }
  })
);

app.delete(
  '/api/onboarding/templates/:id',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const templateId = req.params.id;
    if (!templateId) {
      return res
        .status(400)
        .json({ success: false, error: 'templateId required' });
    }

    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const { data, error } = await supabaseAdmin
        .from('onboarding_templates')
        .delete()
        .eq('id', templateId)
        .eq('created_by', ownerId)
        .select('id, name')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }
      res.json({ success: true, templateId: data.id });
    } catch (error) {
      console.error('template delete error', error);
      res
        .status(400)
        .json({ success: false, error: 'Failed to delete template' });
    }
  })
);

app.get(
  '/api/onboarding/templates',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    try {
      const ownerId = getWizardOwnerId(req.user.id);
      let templates = [];
      try {
        templates = await listTemplatesWithStats(ownerId, req.user.id);
      } catch (templateErr) {
        console.error('template list error', templateErr);
        templates = [];
      }
      res.json({ success: true, templates });
    } catch (error) {
      console.error('list templates error', error);
      res
        .status(500)
        .json({ success: false, error: 'Failed to load templates' });
    }
  })
);

app.get(
  '/api/onboarding/templates/:id',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const { data, error } = await supabaseAdmin
        .from('onboarding_templates')
        .select('*')
        .eq('id', req.params.id)
        .eq('created_by', ownerId)
        .single();
      if (error || !data) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }
      res.json(mapTemplateRow(data));
    } catch (error) {
      console.error('get template error', error);
      res
        .status(500)
        .json({ success: false, error: 'Failed to load template' });
    }
  })
);

app.get(
  '/edge/onboard/preview-template',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const templateId = (req.query.templateId || '').trim();
    if (!templateId) {
      return res
        .status(400)
        .json({ success: false, error: 'templateId required' });
    }
    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const { data, error } = await supabaseAdmin
        .from('onboarding_templates')
        .select('*')
        .eq('id', templateId)
        .eq('created_by', ownerId)
        .single();
      if (error || !data) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }
      res.json({
        preview: true,
        template: mapTemplateRow(data),
        wizard: {
          id: null,
          status: 'preview',
          responses: {}
        }
      });
    } catch (error) {
      console.error('preview template error', error);
      res.status(500).json({ success: false, error: 'Failed to load preview' });
    }
  })
);

app.post(
  '/api/onboarding/templates/:id/publish',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const templateId = req.params.id;
    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const { data, error } = await supabaseAdmin
        .from('onboarding_templates')
        .update({
          status: 'published',
          updated_at: new Date().toISOString()
        })
        .eq('id', templateId)
        .eq('created_by', ownerId)
        .select('*')
        .single();
      if (error) throw error;
      res.json({ success: true, template: mapTemplateRow(data) });
    } catch (error) {
      console.error('publish template error', error);
      res.status(400).json({ success: false, error: 'Publish failed' });
    }
  })
);

app.post(
  '/api/onboarding/templates/:id/clone',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const templateId = req.params.id;
    if (!templateId) {
      return res
        .status(400)
        .json({ success: false, error: 'templateId required' });
    }

    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const { data: existing, error: existingError } = await supabaseAdmin
        .from('onboarding_templates')
        .select('*')
        .eq('id', templateId)
        .eq('created_by', ownerId)
        .single();
      if (existingError || !existing) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }

      const requestedName = coerceString(req.body?.name || '');
      const baseName = coerceString(existing.name || 'Untitled Wizard');
      const defaultCloneName =
        baseName.length > 120
          ? `${baseName.slice(0, 120)} Copy`
          : `${baseName} Copy`;
      const cloneName = (requestedName || defaultCloneName).slice(0, 140);
      const timestamp = new Date().toISOString();

      const mapped = mapTemplateRow(existing);
      const metadata = {
        ...(mapped.metadata || {}),
        createdAt: timestamp,
        updatedAt: null,
        clonedFrom: existing.id,
        clonedAt: timestamp
      };

      const sanitized = sanitizeTemplateInput(
        {
          ...mapped,
          id: null,
          name: cloneName,
          status: 'draft',
          metadata
        },
        { ownerId }
      );

      const locationIdValue = sanitized.locationId
        ? sanitized.locationId.trim()
        : '';
      let locationColumn = null;
      if (locationIdValue && isUuid(locationIdValue)) {
        locationColumn = locationIdValue;
      }

      const definitionWithMeta = {
        ...sanitized.definition,
        metadata: {
          ...(sanitized.definition.metadata || {}),
          locationId: locationIdValue,
          clonedFrom: existing.id,
          clonedAt: timestamp
        }
      };

      const insertPayload = {
        name: sanitized.name,
        description: sanitized.description,
        status: 'draft',
        location_id: locationColumn,
        theme: sanitized.theme,
        definition: definitionWithMeta,
        steps: definitionWithMeta,
        created_by: ownerId
      };

      let { data, error } = await supabaseAdmin
        .from('onboarding_templates')
        .insert(insertPayload)
        .select('*')
        .single();
      if (error) {
        const fallbackPayload = {
          name: sanitized.name,
          steps: definitionWithMeta,
          created_by: ownerId
        };
        ({ data, error } = await supabaseAdmin
          .from('onboarding_templates')
          .insert(fallbackPayload)
          .select('*')
          .single());
        if (error) throw error;
      }

      res.json({ success: true, template: mapTemplateRow(data) });
    } catch (error) {
      console.error('template clone error', error);
      res
        .status(400)
        .json({ success: false, error: 'Failed to clone template' });
    }
  })
);

app.post(
  '/api/onboarding/templates/:id/issue',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const templateId = req.params.id;
    try {
      const ownerId = getWizardOwnerId(req.user.id);
      const { data: template, error: templateError } = await supabaseAdmin
        .from('onboarding_templates')
        .select('id, location_id, definition, steps')
        .eq('id', templateId)
        .eq('created_by', ownerId)
        .single();
      if (templateError || !template) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }
      const templateDefinition = template.definition || template.steps || {};
      const templateMetadata = templateDefinition.metadata || {};
      const requestedLocationId = coerceString(req.body?.locationId || req.body?.location_id || '').trim();
      const templateLocationId = coerceString(templateMetadata.locationId || template.location_id || '').trim();
      const locationId = requestedLocationId || templateLocationId;

      if (!locationId) {
        return res
          .status(400)
          .json({ success: false, error: 'locationId required to issue wizard' });
      }

      const location = await findUserLocation(req.user.id, locationId);

      if (!location) {
        return res
          .status(404)
          .json({ success: false, error: 'Location not found for wizard issue' });
      }

      const result = await issueWizardLinkRecord(
        req.user.id,
        templateId,
        locationId
      );
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('issue wizard error', error);
      res.status(400).json({ success: false, error: 'Failed to issue wizard' });
    }
  })
);

app.post(
  '/api/onboarding/wizards/issue',
  ensureAuthenticated,
  requireWizardEnabled(async (req, res) => {
    const { templateId, locationId } = req.body || {};
    if (!templateId || !locationId) {
      return res.status(400).json({
        success: false,
        error: 'templateId and locationId required'
      });
    }
    try {
      const location = await findUserLocation(req.user.id, locationId);
      if (!location) {
        return res
          .status(404)
          .json({ success: false, error: 'Location not available' });
      }

      const result = await issueWizardLinkRecord(
        req.user.id,
        templateId,
        locationId
      );
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('issue wizard error', error);
      res.status(400).json({ success: false, error: 'Failed to issue wizard' });
    }
  })
);

app.get('/api/onboarding/wizards', ensureAuthenticated, requireWizardEnabled(async (req, res) => {
  const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  const ownerId = getWizardOwnerId(req.user.id);
  const { data, error } = await supabaseAdmin
    .from('onboarding_wizards')
    .select('id, status, submitted_at, location_id, public_token, template:onboarding_templates(name)')
    .eq('org_user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('list wizards error', error);
    return res.status(500).json({ success: false, error: 'Failed to load wizards' });
  }
  const result = (data || []).map((wiz) => ({
    id: wiz.id,
    status: wiz.status,
    submitted_at: wiz.submitted_at,
    location_id: wiz.location_id,
    template_name: wiz.template?.name || '',
    publicUrl: `${baseUrl}/onboard.html?token=${wiz.public_token}`
  }));
  res.json(result);
}));

app.get('/api/onboarding/wizards/:id/diff', ensureAuthenticated, requireWizardEnabled(async (req, res) => {
  const wizardId = req.params.id;
  const { data: wizard, error: wizardError } = await supabaseAdmin
    .from('onboarding_wizards')
    .select('id')
    .eq('id', wizardId)
    .eq('org_user_id', getWizardOwnerId(req.user.id))
    .maybeSingle();
  if (wizardError || !wizard) {
    return res.status(404).json({ success: false, error: 'Wizard not found' });
  }
  const { data, error } = await supabaseAdmin
    .from('onboarding_sync_runs')
    .select('status, diff, error, started_at, finished_at')
    .eq('wizard_id', wizardId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return res.status(404).json({ success: false, error: 'No sync run found' });
  }
  res.json(data);
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    supabase: supabase ? 'connected' : 'not configured',
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured'
  });
});

// LOCATION COMPARISON ENDPOINT
app.post('/api/locations/compare', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationIdA, locationIdB, compareType } = req.body;
  
  if (!locationIdA || !locationIdB) {
    return res.status(400).json({
      success: false,
      error: 'Both location IDs are required'
    });
  }
  
  const locationA = userLocations[userId]?.find(loc => loc.id === locationIdA);
  const locationB = userLocations[userId]?.find(loc => loc.id === locationIdB);
  
  if (!locationA || !locationB) {
    return res.status(404).json({
      success: false,
      error: 'One or both locations not found'
    });
  }
  
  try {
    const comparison = {
      locationA: { id: locationA.id, name: locationA.name },
      locationB: { id: locationB.id, name: locationB.name }
    };
    
    // Compare Custom Values
    if (compareType === 'values' || compareType === 'both') {
      const clientA = createGHLClient(locationA.token);
      const clientB = createGHLClient(locationB.token);
      
      const [resA, resB] = await Promise.all([
        clientA.get(`/locations/${locationA.locationId}/customValues`),
        clientB.get(`/locations/${locationB.locationId}/customValues`)
      ]);
      
      const valuesA = resA.data.customValues || [];
      const valuesB = resB.data.customValues || [];
      
      const mapA = new Map();
      const mapB = new Map();
      
      valuesA.forEach(v => {
        const key = v.fieldKey || `name:${v.name}`;
        mapA.set(key, v);
      });
      
      valuesB.forEach(v => {
        const key = v.fieldKey || `name:${v.name}`;
        mapB.set(key, v);
      });
      
      const onlyInA = [];
      const onlyInB = [];
      const matches = [];
      const variances = [];
      
      mapA.forEach((valueA, key) => {
        if (mapB.has(key)) {
          const valueB = mapB.get(key);
          const valueComparison = {
            fieldKey: valueA.fieldKey || null,
            nameA: valueA.name,
            nameB: valueB.name,
            valueA: valueA.value,
            valueB: valueB.value,
            idA: valueA.id,
            idB: valueB.id
          };
          
          if (valueA.value === valueB.value && valueA.name === valueB.name) {
            valueComparison.isIdentical = true;
            matches.push(valueComparison);
          } else {
            valueComparison.isIdentical = false;
            valueComparison.differences = [];
            
            if (valueA.name !== valueB.name) {
              valueComparison.differences.push({ field: 'name', diffType: 'naming' });
            }
            if (valueA.value !== valueB.value) {
              valueComparison.differences.push({ field: 'value', diffType: 'content' });
            }
            
            variances.push(valueComparison);
          }
        } else {
          onlyInA.push({
            id: valueA.id,
            name: valueA.name,
            fieldKey: valueA.fieldKey,
            value: valueA.value
          });
        }
      });
      
      mapB.forEach((valueB, key) => {
        if (!mapA.has(key)) {
          onlyInB.push({
            id: valueB.id,
            name: valueB.name,
            fieldKey: valueB.fieldKey,
            value: valueB.value
          });
        }
      });
      
      comparison.values = {
        onlyInA,
        onlyInB,
        matches,
        variances,
        stats: {
          totalA: valuesA.length,
          totalB: valuesB.length,
          onlyInA: onlyInA.length,
          onlyInB: onlyInB.length,
          matches: matches.length,
          differences: variances.length,
          netVariance: Math.abs(valuesA.length - valuesB.length)
        }
      };
    }
    
    // Compare Custom Fields
    if (compareType === 'fields' || compareType === 'both') {
      const clientA = createGHLClient(locationA.token);
      const clientB = createGHLClient(locationB.token);
      
      const [resA, resB] = await Promise.all([
        clientA.get(`/locations/${locationA.locationId}/customFields`),
        clientB.get(`/locations/${locationB.locationId}/customFields`)
      ]);
      
      const fieldsA = resA.data.customFields || [];
      const fieldsB = resB.data.customFields || [];
      
      const mapA = new Map();
      const mapB = new Map();
      
      fieldsA.forEach(f => {
        const key = f.fieldKey || `name:${f.name.toLowerCase()}`;
        mapA.set(key, f);
      });
      
      fieldsB.forEach(f => {
        const key = f.fieldKey || `name:${f.name.toLowerCase()}`;
        mapB.set(key, f);
      });
      
      const onlyInA = [];
      const onlyInB = [];
      const matches = [];
      const variances = [];
      
      mapA.forEach((fieldA, key) => {
        if (mapB.has(key)) {
          const fieldB = mapB.get(key);
          const fieldComparison = {
            fieldKey: fieldA.fieldKey || null,
            nameA: fieldA.name,
            nameB: fieldB.name,
            dataTypeA: fieldA.dataType,
            dataTypeB: fieldB.dataType,
            modelA: fieldA.model,
            modelB: fieldB.model,
            placeholderA: fieldA.placeholder,
            placeholderB: fieldB.placeholder,
            idA: fieldA.id,
            idB: fieldB.id
          };
          
          if (
            fieldA.dataType === fieldB.dataType &&
            fieldA.model === fieldB.model &&
            fieldA.placeholder === fieldB.placeholder &&
            fieldA.name === fieldB.name
          ) {
            fieldComparison.isIdentical = true;
            matches.push(fieldComparison);
          } else {
            fieldComparison.isIdentical = false;
            fieldComparison.differences = [];
            
            if (fieldA.name !== fieldB.name) {
              fieldComparison.differences.push({ field: 'name', diffType: 'naming' });
            }
            if (fieldA.dataType !== fieldB.dataType) {
              fieldComparison.differences.push({ field: 'dataType', diffType: 'type' });
            }
            if (fieldA.model !== fieldB.model) {
              fieldComparison.differences.push({ field: 'model', diffType: 'model' });
            }
            if (fieldA.placeholder !== fieldB.placeholder) {
              fieldComparison.differences.push({ field: 'placeholder', diffType: 'placeholder' });
            }
            
            variances.push(fieldComparison);
          }
        } else {
          onlyInA.push({
            id: fieldA.id,
            name: fieldA.name,
            fieldKey: fieldA.fieldKey,
            dataType: fieldA.dataType,
            model: fieldA.model,
            placeholder: fieldA.placeholder
          });
        }
      });
      
      mapB.forEach((fieldB, key) => {
        if (!mapA.has(key)) {
          onlyInB.push({
            id: fieldB.id,
            name: fieldB.name,
            fieldKey: fieldB.fieldKey,
            dataType: fieldB.dataType,
            model: fieldB.model,
            placeholder: fieldB.placeholder
          });
        }
      });
      
      comparison.fields = {
        onlyInA,
        onlyInB,
        matches,
        variances,
        stats: {
          totalA: fieldsA.length,
          totalB: fieldsB.length,
          onlyInA: onlyInA.length,
          onlyInB: onlyInB.length,
          matches: matches.length,
          differences: variances.length,
          netVariance: Math.abs(fieldsA.length - fieldsB.length)
        }
      };
    }
    
    // Compare Trigger Links
    if (compareType === 'links') {
      const clientA = createGHLClient(locationA.token);
      const clientB = createGHLClient(locationB.token);
      
      const [resA, resB] = await Promise.all([
        clientA.get('/links', { params: { locationId: locationA.locationId } }),
        clientB.get('/links', { params: { locationId: locationB.locationId } })
      ]);
      
      const linksAData = resA.data?.links || resA.data?.link || resA.data || [];
      const linksBData = resB.data?.links || resB.data?.link || resB.data || [];
      const linksA = Array.isArray(linksAData) ? linksAData : [linksAData].filter(Boolean);
      const linksB = Array.isArray(linksBData) ? linksBData : [linksBData].filter(Boolean);
      
      const normalizeLink = (link) => {
        const name = link?.name || link?.linkName || '';
        const slug = (link?.slug || link?.identifier || '').toLowerCase();
        const redirect = (link?.redirectTo || link?.redirectUrl || '').trim();
        const key = slug || name.toLowerCase();
        return {
          key,
          id: link?.id || link?._id || link?.linkId || link?.uuid || null,
          name,
          slug: link?.slug || link?.identifier || '',
          redirectTo: redirect,
          shortUrl: link?.shortUrl || link?.shortLink || '',
          fullUrl: link?.fullUrl || link?.url || '',
          raw: link
        };
      };
      
      const mapA = new Map();
      const mapB = new Map();
      
      linksA.forEach(link => {
        const normalized = normalizeLink(link);
        if (normalized.key) {
          mapA.set(normalized.key, normalized);
        }
      });
      
      linksB.forEach(link => {
        const normalized = normalizeLink(link);
        if (normalized.key) {
          mapB.set(normalized.key, normalized);
        }
      });
      
      const onlyInA = [];
      const onlyInB = [];
      const matches = [];
      const variances = [];
      
      mapA.forEach((linkA, key) => {
        if (mapB.has(key)) {
          const linkB = mapB.get(key);
          const linkComparison = {
            key,
            idA: linkA.id,
            idB: linkB.id,
            nameA: linkA.name,
            nameB: linkB.name,
            redirectA: linkA.redirectTo,
            redirectB: linkB.redirectTo,
            urlA: linkA.shortUrl || linkA.fullUrl || '',
            urlB: linkB.shortUrl || linkB.fullUrl || ''
          };
          
          if (
            linkA.name === linkB.name &&
            linkA.redirectTo === linkB.redirectTo &&
            (linkA.shortUrl || linkA.fullUrl || '') === (linkB.shortUrl || linkB.fullUrl || '')
          ) {
            linkComparison.isIdentical = true;
            matches.push(linkComparison);
          } else {
            linkComparison.isIdentical = false;
            linkComparison.differences = [];
            
            if (linkA.name !== linkB.name) {
              linkComparison.differences.push({ field: 'name', diffType: 'naming' });
            }
            if (linkA.redirectTo !== linkB.redirectTo) {
              linkComparison.differences.push({ field: 'redirect', diffType: 'destination' });
            }
            if ((linkA.shortUrl || linkA.fullUrl || '') !== (linkB.shortUrl || linkB.fullUrl || '')) {
              linkComparison.differences.push({ field: 'url', diffType: 'link' });
            }
            
            variances.push(linkComparison);
          }
        } else {
          onlyInA.push({
            id: linkA.id,
            name: linkA.name,
            redirectTo: linkA.redirectTo,
            shortUrl: linkA.shortUrl || linkA.fullUrl || ''
          });
        }
      });
      
      mapB.forEach((linkB, key) => {
        if (!mapA.has(key)) {
          onlyInB.push({
            id: linkB.id,
            name: linkB.name,
            redirectTo: linkB.redirectTo,
            shortUrl: linkB.shortUrl || linkB.fullUrl || ''
          });
        }
      });
      
      comparison.triggerLinks = {
        onlyInA,
        onlyInB,
        matches,
        variances,
        stats: {
          totalA: linksA.length,
          totalB: linksB.length,
          onlyInA: onlyInA.length,
          onlyInB: onlyInB.length,
          matches: matches.length,
          differences: variances.length,
          netVariance: Math.abs(linksA.length - linksB.length)
        }
      };
    }

    // Compare Tags
    if (compareType === 'tags') {
      const clientA = createGHLClient(locationA.token);
      const clientB = createGHLClient(locationB.token);

      const [resA, resB] = await Promise.all([
        clientA.get(`/locations/${locationA.locationId}/tags`),
        clientB.get(`/locations/${locationB.locationId}/tags`)
      ]);

      const tagsA = resA.data?.tags || resA.data || [];
      const tagsB = resB.data?.tags || resB.data || [];

      const normalize = (tag) => {
        const id = tag?.id || tag?._id || tag?.tagId || tag?.uuid || tag?.name;
        const name = (tag?.name || '').trim();
        const key = name.toLowerCase();
        return { key, id, name, raw: tag };
      };

      const mapA = new Map();
      const mapB = new Map();

      tagsA.forEach(tag => {
        const normalized = normalize(tag);
        if (normalized.key) {
          mapA.set(normalized.key, normalized);
        }
      });

      tagsB.forEach(tag => {
        const normalized = normalize(tag);
        if (normalized.key) {
          mapB.set(normalized.key, normalized);
        }
      });

      const onlyInA = [];
      const onlyInB = [];
      const matches = [];
      const variances = [];

      mapA.forEach((tagA, key) => {
        if (mapB.has(key)) {
          const tagB = mapB.get(key);
          const tagComparison = {
            key,
            idA: tagA.id,
            idB: tagB.id,
            nameA: tagA.name,
            nameB: tagB.name
          };

          if (tagA.name === tagB.name) {
            tagComparison.isIdentical = true;
            matches.push(tagComparison);
          } else {
            tagComparison.isIdentical = false;
            tagComparison.differences = [];

            if (tagA.name !== tagB.name) {
              tagComparison.differences.push({ field: 'name', diffType: 'naming' });
            }

            variances.push(tagComparison);
          }
        } else {
          onlyInA.push({
            id: tagA.id,
            name: tagA.name
          });
        }
      });

      mapB.forEach((tagB, key) => {
        if (!mapA.has(key)) {
          onlyInB.push({
            id: tagB.id,
            name: tagB.name
          });
        }
      });

      comparison.tags = {
        onlyInA,
        onlyInB,
        matches,
        variances,
        stats: {
          totalA: tagsA.length,
          totalB: tagsB.length,
          onlyInA: onlyInA.length,
          onlyInB: onlyInB.length,
          matches: matches.length,
          differences: variances.length,
          netVariance: Math.abs(tagsA.length - tagsB.length)
        }
      };
    }

    res.json({
      success: true,
      comparison
    });
    
  } catch (error) {
    console.error('Comparison error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Multi-Location LeadConnector Server Started');
  console.log('- Google OAuth:', process.env.GOOGLE_CLIENT_ID ? 'Configured ✓' : 'Not configured ✗');
  console.log('- Session Secret:', process.env.SESSION_SECRET ? 'Custom ✓' : 'Using default ⚠');
  console.log('- Supabase:', process.env.SUPABASE_URL ? 'Connected ✓' : 'Not configured ✗');
  console.log('- Stripe:', process.env.STRIPE_SECRET_KEY ? 'Configured ✓' : 'Not configured ✗');
  console.log('- Uploads Directory:', uploadsDir);
  console.log('');
  console.log(`Application available at http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});
