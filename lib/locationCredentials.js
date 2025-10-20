const DEFAULT_TYPE = 'private_token';
const SUPPORTED_SOCIAL_PLATFORMS = [
  'google',
  'facebook',
  'instagram',
  'linkedin',
  'tiktok',
  'youtube'
];

function decodeLocationCredentials(rawToken) {
  if (!rawToken) {
    return { type: DEFAULT_TYPE, accessToken: '' };
  }

  if (typeof rawToken === 'string') {
    const trimmed = rawToken.trim();
    if (!trimmed) {
      return { type: DEFAULT_TYPE, accessToken: '' };
    }
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return ensureCredentialShape(parsed);
        }
      } catch (error) {
        console.warn('Failed to parse stored location credentials; falling back to raw token.');
        return { type: DEFAULT_TYPE, accessToken: trimmed };
      }
    }
    return { type: DEFAULT_TYPE, accessToken: trimmed };
  }

  if (typeof rawToken === 'object') {
    return ensureCredentialShape(rawToken);
  }

  return { type: DEFAULT_TYPE, accessToken: String(rawToken) };
}

function ensureCredentialShape(credential) {
  if (!credential || typeof credential !== 'object') {
    return { type: DEFAULT_TYPE, accessToken: '' };
  }

  const detectedType =
    credential.type ||
    (credential.refreshToken || credential.scopeLevel || credential.expiresAt
      ? 'oauth'
      : DEFAULT_TYPE);

  const metadata = normalizeMetadata(credential.metadata);

  return {
    ...credential,
    type: detectedType,
    metadata
  };
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  const normalised = { ...metadata };
  if (normalised.socialProfiles && typeof normalised.socialProfiles === 'object') {
    const social = {};
    SUPPORTED_SOCIAL_PLATFORMS.forEach((platform) => {
      const list = normalised.socialProfiles[platform];
      if (Array.isArray(list)) {
        social[platform] = list
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            ...item,
            accountId: item.accountId || item.id || null,
            displayName: item.displayName || item.name || null,
            connectedAt: item.connectedAt || item.updatedAt || null,
            locations: Array.isArray(item.locations) ? item.locations : []
          }))
          .filter((item) => item.accountId);
      }
    });
    normalised.socialProfiles = social;
  }
  return normalised;
}

function encodeLocationCredentials(credentials) {
  if (!credentials) return '';
  try {
    return JSON.stringify(credentials);
  } catch (error) {
    console.error('Failed to serialise location credentials', error);
    return '';
  }
}

function getLocationAccessToken(rawCredentials) {
  const credentials = decodeLocationCredentials(rawCredentials);
  if (!credentials) return '';

  if (credentials.type === 'oauth') {
    return credentials.accessToken || '';
  }

  return (
    credentials.accessToken ||
    credentials.token ||
    credentials.raw ||
    ''
  );
}

function isOAuthCredential(rawCredentials) {
  const credentials = decodeLocationCredentials(rawCredentials);
  return credentials.type === 'oauth';
}

function isAccessTokenExpired(rawCredentials, bufferSeconds = 60) {
  const credentials = decodeLocationCredentials(rawCredentials);
  if (!credentials?.expiresAt) {
    return false;
  }
  const expiry = Date.parse(credentials.expiresAt);
  if (Number.isNaN(expiry)) {
    return false;
  }
  const bufferMs = bufferSeconds * 1000;
  return Date.now() >= expiry - bufferMs;
}

function sanitizeCredentialsForClient(rawCredentials) {
  const credentials = decodeLocationCredentials(rawCredentials);
  if (!credentials) {
    return { type: DEFAULT_TYPE };
  }

  const {
    type = DEFAULT_TYPE,
    scopeLevel = null,
    userType = null,
    installedAt = null,
    providerAccountId = null,
    providerLocationId = null,
    metadata = {}
  } = credentials;

  return {
    type,
    scopeLevel,
    userType,
    installedAt,
    providerAccountId,
    providerLocationId,
    businessId: metadata.businessId || null,
    socialProfiles: sanitizeSocialProfiles(credentials)
  };
}

function sanitizeSocialProfiles(credentials) {
  const metadataProfiles = credentials?.metadata?.socialProfiles || {};
  const directProfiles = credentials?.socialProfiles || {};
  const mapForPlatform = (platform) => {
    const records = Array.isArray(directProfiles[platform])
      ? directProfiles[platform]
      : Array.isArray(metadataProfiles[platform])
      ? metadataProfiles[platform]
      : [];
    return records
      .filter((record) => record && typeof record === 'object')
      .map((record) => ({
        accountId: record.accountId || record.id || null,
        displayName: record.displayName || record.name || record.accountName || null,
        placement: record.placement || null,
        locations: Array.isArray(record.locations) ? record.locations : [],
        connectedAt: record.connectedAt || record.updatedAt || null,
        platform: record.platform || platform
      }))
      .filter((item) => item.accountId);
  };

  const output = {};
  SUPPORTED_SOCIAL_PLATFORMS.forEach((platform) => {
    const items = mapForPlatform(platform);
    if (items.length) {
      output[platform] = items;
    }
  });
  return output;
}

function buildOAuthCredential(tokenResponse, {
  scopeLevel = null,
  metadata = {}
} = {}) {
  if (!tokenResponse || typeof tokenResponse !== 'object') {
    throw new Error('tokenResponse is required to build OAuth credentials');
  }

  const {
    access_token: accessToken,
    refresh_token: refreshToken = null,
    expires_in: expiresIn = null,
    refresh_token_expires_in: refreshExpiresIn = null,
    scope,
    token_type: tokenType,
    userType,
    companyId,
    locationId
  } = tokenResponse;

  if (!accessToken) {
    throw new Error('OAuth token response missing access_token');
  }

  const now = Date.now();
  const expiresAt =
    typeof expiresIn === 'number'
      ? new Date(now + expiresIn * 1000).toISOString()
      : null;
  const refreshTokenExpiresAt =
    typeof refreshExpiresIn === 'number'
      ? new Date(now + refreshExpiresIn * 1000).toISOString()
      : null;

  const scopeList = Array.isArray(scope)
    ? scope
    : typeof scope === 'string'
      ? scope.split(/\s+/).filter(Boolean)
      : [];

  return {
    type: 'oauth',
    accessToken,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
    scope: scopeList,
    scopeLevel: scopeLevel || deriveScopeLevel(userType),
    userType: userType || null,
    tokenType: tokenType || 'Bearer',
    providerAccountId: metadata.providerAccountId ?? companyId ?? null,
    providerLocationId: metadata.providerLocationId ?? locationId ?? null,
    installedAt: metadata.installedAt || new Date(now).toISOString(),
    metadata: {
      ...metadata,
      scope: scopeList,
      socialProfiles: normalizeMetadata(metadata).socialProfiles
    }
  };
}

function deriveScopeLevel(userType) {
  if (!userType) return null;
  return userType === 'Company' ? 'agency' : 'location';
}

module.exports = {
  buildOAuthCredential,
  decodeLocationCredentials,
  encodeLocationCredentials,
  getLocationAccessToken,
  isAccessTokenExpired,
  isOAuthCredential,
  sanitizeCredentialsForClient,
  sanitizeSocialProfiles
};
