// jobs/syncWizard.js
require('dotenv').config();

const FormData = require('form-data');
const { supabaseAdmin, downloadWizardFile } = require('../lib/storage');
const { createGHLClient } = require('../lib/ghlClient');
const {
  decodeLocationCredentials,
  encodeLocationCredentials,
  getLocationAccessToken,
  isAccessTokenExpired
} = require('../lib/locationCredentials');
const { refreshOAuthCredential } = require('../lib/ghlOAuth');
const { exponentialBackoff } = require('../utils/backoff');

const GHL_OAUTH_TOKEN_URL =
  process.env.GHL_OAUTH_TOKEN_URL ||
  'https://services.leadconnectorhq.com/oauth/token';
const GHL_OAUTH_CLIENT_ID = process.env.GHL_OAUTH_CLIENT_ID || '';
const GHL_OAUTH_CLIENT_SECRET = process.env.GHL_OAUTH_CLIENT_SECRET || '';

const SYNC_QUEUE = [];
let processing = false;

function enqueueWizardSync(wizardId) {
  SYNC_QUEUE.push(wizardId);
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (SYNC_QUEUE.length) {
    const wizardId = SYNC_QUEUE.shift();
    try {
      await runSync(wizardId);
    } catch (err) {
      console.error('Wizard sync failed:', wizardId, err);
    }
  }
  processing = false;
}

async function runSync(wizardId) {
  const { data: wizard, error: wizardErr } = await supabaseAdmin
    .from('onboarding_wizards')
    .select('*, template:onboarding_templates(*), steps:onboarding_steps(*), runs:onboarding_sync_runs(*)')
    .eq('id', wizardId)
    .maybeSingle();

  if (wizardErr || !wizard) {
    throw wizardErr || new Error('Wizard not found');
  }

  const locationToken = await getLocationToken(wizard.org_user_id, wizard.location_id);
  const client = createGHLClient(locationToken);

  const payload = buildPayload(wizard);
  const syncRunId = await recordRunStart(wizardId);

  try {
    const diff = await syncWithRetries(client, payload);
    await supabaseAdmin
      .from('onboarding_sync_runs')
      .update({ status: 'success', finished_at: new Date().toISOString(), diff })
      .eq('id', syncRunId);
    await supabaseAdmin
      .from('onboarding_wizards')
      .update({ status: 'synced' })
      .eq('id', wizardId);
  } catch (error) {
    await supabaseAdmin
      .from('onboarding_sync_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: error.message
      })
      .eq('id', syncRunId);
    await supabaseAdmin
      .from('onboarding_wizards')
      .update({ status: 'error' })
      .eq('id', wizardId);
    throw error;
  }
}

async function syncWithRetries(client, payload) {
  return exponentialBackoff(async (attempt) => {
    try {
      const diff = {
        fields: [],
        values: [],
        triggerLinks: [],
        media: [],
        tags: []
      };

      for (const field of payload.customFields) {
        if (field.mode === 'create') {
          const request = {
            name: field.config?.name || field.label,
            dataType: field.config?.dataType || 'TEXT',
            placeholder: field.config?.placeholder || '',
            options: field.config?.options || []
          };
          const resp = await client.post(
            `/locations/${payload.locationId}/customFields`,
            request
          );
          diff.fields.push({ blockId: field.blockId, request, response: resp.data });
        } else {
          diff.fields.push({
            blockId: field.blockId,
            skipped: true,
            reason: 'existing field operations not implemented'
          });
        }
      }

      for (const value of payload.customValues) {
        if (!value.value || !String(value.value).trim()) continue;
        if (value.mode === 'create' || !value.referenceId) {
          const request = {
            name: value.name || `Value ${value.blockId}`,
            value: value.value
          };
          const resp = await client.post(
            `/locations/${payload.locationId}/customValues`,
            request
          );
          diff.values.push({ blockId: value.blockId, request, response: resp.data });
        } else {
          const request = { value: value.value };
          try {
            const resp = await client.put(
              `/locations/${payload.locationId}/customValues/${value.referenceId}`,
              request
            );
            diff.values.push({ blockId: value.blockId, request, response: resp.data });
          } catch (err) {
            if (err.response?.status === 404) {
              const fallback = await client.post(
                `/locations/${payload.locationId}/customValues`,
                { name: value.name || `Value ${value.blockId}`, value: value.value }
              );
              diff.values.push({
                blockId: value.blockId,
                request,
                response: fallback.data,
                fallback: true
              });
            } else {
              throw err;
            }
          }
        }
      }

      for (const link of payload.triggerLinks) {
        if (!link.redirectTo) continue;
        const request = {
          locationId: payload.locationId,
          name: link.name || `Trigger Link ${link.blockId}`,
          redirectTo: link.redirectTo
        };
        if (link.mode === 'existing' && link.referenceId) {
          try {
            const resp = await client.put(`/links/${link.referenceId}`, request);
            diff.triggerLinks.push({ blockId: link.blockId, request, response: resp.data });
          } catch (err) {
            if (err.response?.status === 404) {
              const fallback = await client.post('/links/', request);
              diff.triggerLinks.push({ blockId: link.blockId, request, response: fallback.data, fallback: true });
            } else {
              throw err;
            }
          }
        } else {
          const resp = await client.post('/links/', request);
          diff.triggerLinks.push({ blockId: link.blockId, request, response: resp.data });
        }
      }

      for (const tag of payload.tags) {
        const names = Array.isArray(tag.names) ? tag.names.filter(Boolean) : [];
        for (const name of names) {
          try {
            const resp = await client.post(`/locations/${payload.locationId}/tags`, {
              name
            });
            diff.tags.push({ blockId: tag.blockId, request: { name }, response: resp.data });
          } catch (err) {
            diff.tags.push({
              blockId: tag.blockId,
              request: { name },
              error: err.response?.data || err.message
            });
          }
        }
      }

      for (const media of payload.media) {
        const downloadable = await downloadWizardFile(media.storageKey);
        const arrayBuffer = await downloadable.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const formData = new FormData();
        formData.append('file', buffer, {
          filename: media.name,
          contentType: media.mime
        });
        const resp = await client.post('/medias/upload-file', formData, {
          headers: formData.getHeaders()
        });
        diff.media.push({ blockId: media.blockId, name: media.name, response: resp.data });
      }

      return diff;
    } catch (err) {
      if (err.response?.status === 429 && attempt < 3) {
        throw err;
      }
      throw err;
    }
  }, 3);
}

function buildPayload(wizard) {
  const definition = wizard.template?.definition || wizard.template?.steps || {};
  const pages = Array.isArray(definition.pages)
    ? definition.pages
    : Array.isArray(definition)
      ? definition
      : [];

  const responseByPage = new Map();
  (wizard.steps || []).forEach((step) => {
    responseByPage.set(step.step_key, step.payload?.blocks || {});
  });

  const payload = {
    locationId: wizard.location_id,
    customFields: [],
    customValues: [],
    triggerLinks: [],
    tags: [],
    media: []
  };

  pages.forEach((page) => {
    const pageResponses = responseByPage.get(page.id) || {};
    (page.blocks || []).forEach((block) => {
      const response = pageResponses[block.id] || {};
      switch (block.type) {
        case 'custom_field':
          payload.customFields.push({
            blockId: block.id,
            mode: block.mode || 'existing',
            referenceId: block.referenceId || null,
            config: block.newEntity || {},
            label: block.title,
            value: response.value || null
          });
          break;
        case 'custom_value':
          payload.customValues.push({
            blockId: block.id,
            mode: block.mode || 'existing',
            referenceId: block.referenceId || null,
            name: block.newEntity?.name || block.title,
            value: response.value || ''
          });
          break;
        case 'trigger_link':
          payload.triggerLinks.push({
            blockId: block.id,
            mode: block.mode || 'existing',
            referenceId: block.referenceId || null,
            name: block.newEntity?.name || block.title,
            redirectTo: response.value || block.newEntity?.redirectTo || ''
          });
          break;
        case 'tag': {
          const values = Array.isArray(response.value)
            ? response.value
            : typeof response.value === 'string'
              ? response.value.split(',').map((tag) => tag.trim()).filter(Boolean)
              : [];
          payload.tags.push({
            blockId: block.id,
            names: values,
            mode: block.mode || 'existing',
            referenceId: block.referenceId || null
          });
          break;
        }
        case 'media': {
          const uploads = Array.isArray(response.uploads) ? response.uploads : [];
          uploads.forEach((file) => {
            payload.media.push({
              blockId: block.id,
              storageKey: file.storageKey,
              name: file.name,
              mime: file.mime
            });
          });
          break;
        }
        default:
          break;
      }
    });
  });

  return payload;
}

async function recordRunStart(wizardId) {
  const { data, error } = await supabaseAdmin
    .from('onboarding_sync_runs')
    .insert({ wizard_id: wizardId })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function getLocationToken(orgUserId, locationId) {
  const { data, error } = await supabaseAdmin
    .from('saved_locations')
    .select('token')
    .eq('user_id', orgUserId)
    .eq('location_id', locationId)
    .maybeSingle();
  if (error || !data) {
    throw error || new Error('Location token not found');
  }
  let credentials = decodeLocationCredentials(data.token);
  const shouldRefresh =
    credentials?.type === 'oauth' &&
    credentials.refreshToken &&
    (isAccessTokenExpired(credentials, 180) ||
      !credentials.accessToken);

  if (
    shouldRefresh &&
    GHL_OAUTH_CLIENT_ID &&
    GHL_OAUTH_CLIENT_SECRET
  ) {
    try {
      const refreshed = await refreshOAuthCredential(credentials, {
        clientId: GHL_OAUTH_CLIENT_ID,
        clientSecret: GHL_OAUTH_CLIENT_SECRET,
        tokenUrl: GHL_OAUTH_TOKEN_URL
      });
      credentials = {
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
      await supabaseAdmin
        .from('saved_locations')
        .update({
          token: encodeLocationCredentials(credentials),
          last_used: new Date().toISOString()
        })
        .eq('user_id', orgUserId)
        .eq('location_id', locationId);
    } catch (refreshError) {
      console.error(
        'Failed to refresh HighLevel credential for location',
        locationId,
        refreshError.response?.data || refreshError.message
      );
    }
  }

  return getLocationAccessToken(credentials);
}

module.exports = {
  enqueueWizardSync,
  runSync // exported for tests
};
