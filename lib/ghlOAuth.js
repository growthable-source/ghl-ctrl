const axios = require('axios');
const { buildOAuthCredential } = require('./locationCredentials');

async function refreshOAuthCredential(credential, {
  clientId,
  clientSecret,
  tokenUrl
}) {
  if (!credential || credential.type !== 'oauth') {
    throw new Error('Refresh requires an OAuth credential');
  }
  if (!credential.refreshToken) {
    throw new Error('OAuth credential missing refresh token');
  }
  if (!clientId || !clientSecret) {
    throw new Error('HighLevel OAuth client credentials are not configured');
  }
  const url = tokenUrl || 'https://services.leadconnectorhq.com/oauth/token';
  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await axios.post(url, payload.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const tokenData = response.data || {};
  const refreshed = buildOAuthCredential(tokenData, {
    scopeLevel: credential.scopeLevel,
    metadata: {
      ...(credential.metadata || {}),
      providerAccountId: credential.providerAccountId,
      providerLocationId: credential.providerLocationId,
      installationId: credential.metadata?.installationId || tokenData.installationId || null,
      installedAt: credential.installedAt
    }
  });

  if (!refreshed.refreshToken) {
    refreshed.refreshToken = credential.refreshToken;
  }
  if (!refreshed.providerAccountId && credential.providerAccountId) {
    refreshed.providerAccountId = credential.providerAccountId;
  }
  if (!refreshed.providerLocationId && credential.providerLocationId) {
    refreshed.providerLocationId = credential.providerLocationId;
  }
  if (!refreshed.scope || refreshed.scope.length === 0) {
    refreshed.scope = credential.scope || [];
  }
  refreshed.metadata = {
    ...(credential.metadata || {}),
    ...(refreshed.metadata || {})
  };

  return refreshed;
}

module.exports = {
  refreshOAuthCredential
};
