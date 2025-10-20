const axios = require('axios');
const {
  getLocationAccessToken
} = require('./locationCredentials');

const DEFAULT_VERSION = '2021-07-28';

function resolveAccessToken(tokenOrCredentials) {
  const resolved = getLocationAccessToken(tokenOrCredentials);
  if (!resolved) {
    throw new Error('Missing GoHighLevel access token');
  }
  return resolved;
}

function createGHLClient(tokenOrCredentials) {
  const accessToken = resolveAccessToken(tokenOrCredentials);
  return axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: DEFAULT_VERSION,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });
}

module.exports = {
  createGHLClient,
  resolveAccessToken
};
