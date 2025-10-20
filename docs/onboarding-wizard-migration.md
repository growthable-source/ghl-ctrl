# Onboarding Wizard Upgrade Notes

## Database migrations (Supabase)

Run the following SQL against your Supabase project to introduce the new template schema. The statements are idempotent (`IF NOT EXISTS`) so you can safely re-run them.

```sql
ALTER TABLE onboarding_templates
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS theme jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS definition jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS location_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE onboarding_templates
SET definition = steps
WHERE (definition IS NULL OR jsonb_typeof(definition) IS DISTINCT FROM 'object')
  AND steps IS NOT NULL;
```

No other tables require structural changes; `onboarding_steps.payload` now stores a `blocks` object, but the column itself already exists.

## Build / install

```bash
npm install
npm run build:admin   # bundles the new React-based admin builder to public/build/
```

`npm run dev:admin` keeps the admin bundle up to date while developing.

## OAuth / Marketplace integration scaffolding

- Added `lib/locationCredentials.js` to normalise stored tokens (private and OAuth) and expose helpers for encoding, resolving access tokens, and sanitising data for the UI.
- New Express routes `/oauth/leadconnector/start` and `/oauth/leadconnector/callback` handle the HighLevel marketplace install flow. Configure them with `GHL_OAUTH_CLIENT_ID`, `GHL_OAUTH_CLIENT_SECRET`, optional `GHL_OAUTH_REDIRECT_URI`, `GHL_OAUTH_SCOPES`, and (for marketplace installs) `GHL_OAUTH_VERSION_ID`. By default the backend requests `contacts.readonly opportunities.readonly businesses.readonly locations/customValues.readonly locations/customValues.write locations/customFields.readonly locations/customFields.write locations/tags.readonly locations/tags.write medias.readonly medias.write links.readonly links.write socialplanner/oauth.readonly`.
- Access tokens are refreshed automatically via `lib/ghlOAuth.js` whenever they near expiry, and refreshed credentials are persisted back to Supabase.
- Social profiles are now tracked in location credential metadata (initial support for Google Business Profile). Admins can connect from the new “Social Profiles” tab, and onboarding builders can add a Social Profiles block to request access.
- OAuth installs and private tokens now share the same `saved_locations` storage; credentials are persisted as JSON with metadata such as `scopeLevel`, `providerAccountId`, and refresh token timestamps.
- The admin builder navigation now exposes a **Connect CRM** action that launches a shared connection modal. The main dashboard header includes the same entry point, surfacing both “Install Marketplace App” and “Use Private Integration Token” paths.
- All token consumers (server routes, sync jobs, API client) resolve access tokens through the new helpers, so legacy private tokens continue to work during the migration.

## Onboarding builder updates

- Added a Social Profiles block to the builder palette. Editors can select which platforms to request (Google available now; the rest show as “coming soon”), customise the instructions, and tweak the call-to-action label.

## Manual verification

1. Authenticate and open `/admin/onboarding.html`.
2. Select a location, build a wizard (add pages, blocks, and theme).
3. Save the draft, publish, and generate a share link.
4. Open the public link (`/onboard.html?token=...`) and walk through each page:
   - Autosave triggers as you type.
   - Uploads appear immediately.
   - Required fields gate the final submit.
5. Submit and confirm the sync worker processes the job (logs + Supabase `onboarding_sync_runs`).
