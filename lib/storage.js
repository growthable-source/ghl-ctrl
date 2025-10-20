const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ONBOARDING_BUCKET = 'onboarding-uploads';

let supabaseAdmin = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
} else {
  console.warn('[storage] Supabase service role credentials missing; onboarding wizard storage disabled.');
}

function assertSupabaseAdmin() {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client unavailable; onboarding storage is not configured.');
  }
}

async function ensureBucket() {
  assertSupabaseAdmin();
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw error;
  if (!buckets || !buckets.find((b) => b.name === ONBOARDING_BUCKET)) {
    const { error: createError } = await supabaseAdmin.storage.createBucket(ONBOARDING_BUCKET, {
      public: false,
      fileSizeLimit: 20 * 1024 * 1024
    });
    if (createError) throw createError;
  }
}

async function uploadWizardFile(wizardId, fileBuffer, mime, originalName) {
  assertSupabaseAdmin();
  await ensureBucket();
  const ext = originalName.includes('.') ? originalName.split('.').pop() : 'bin';
  const key = `${wizardId}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`.replace(/\s+/g, '_');
  const { error } = await supabaseAdmin.storage
    .from(ONBOARDING_BUCKET)
    .upload(key, fileBuffer, { contentType: mime, upsert: false });
  if (error) throw error;
  const signedUrl = await signWizardFile(key);
  return { storageKey: key, signedUrl };
}

async function signWizardFile(storageKey, expiresInSeconds = 1800) {
  assertSupabaseAdmin();
  await ensureBucket();
  const { data, error } = await supabaseAdmin.storage
    .from(ONBOARDING_BUCKET)
    .createSignedUrl(storageKey, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

async function downloadWizardFile(storageKey) {
  assertSupabaseAdmin();
  await ensureBucket();
  const { data, error } = await supabaseAdmin.storage.from(ONBOARDING_BUCKET).download(storageKey);
  if (error) throw error;
  return data;
}

async function uploadBuilderAsset(prefix, fileBuffer, mime, originalName) {
  assertSupabaseAdmin();
  await ensureBucket();
  const safePrefix = prefix ? prefix.replace(/[^a-zA-Z0-9-_]/g, '') : 'builder';
  const ext = originalName.includes('.') ? originalName.split('.').pop() : 'bin';
  const key = `builder/${safePrefix}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`.replace(/\s+/g, '_');
  const { error } = await supabaseAdmin.storage
    .from(ONBOARDING_BUCKET)
    .upload(key, fileBuffer, { contentType: mime, upsert: false });
  if (error) throw error;
  const signedUrl = await signWizardFile(key, 3600);
  return { storageKey: key, signedUrl };
}

module.exports = {
  supabaseAdmin,
  uploadWizardFile,
  signWizardFile,
  downloadWizardFile,
  uploadBuilderAsset,
  ONBOARDING_BUCKET
};
