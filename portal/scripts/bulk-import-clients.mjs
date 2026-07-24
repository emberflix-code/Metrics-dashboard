/**
 * Generates SQL to bulk-create clients from Clients.xlsx, each with a login
 * user, scoped ad_account_ids, and a leads source (Google Sheet tab or GHL).
 *
 * This script does NOT touch any database directly — it only prints SQL.
 * Review the output, then run it yourself against the production DB
 * (e.g. `psql $DATABASE_URL -f bulk-import-clients.sql` or paste into the
 * Railway query console).
 *
 * Usage: node scripts/bulk-import-clients.mjs > bulk-import-clients.sql
 *
 * GHL fields (ghlToken/ghlLocationId) are optional per client. When present,
 * the token is encrypted here (not by the DB) using the same AES-256-GCM
 * scheme as src/lib/crypto.ts, so TOKEN_ENCRYPTION_KEY must be set in the
 * shell running this script. Inlined rather than imported to avoid ESM/TS
 * module-resolution friction between this plain .mjs script and the Next.js
 * source tree.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const SHEET_ID = '1KBKGWqlgYJTXOuovNs_E23wZOYHn_9-DWWCXai_FPlw';
const EMAIL_DOMAIN = 'gmn.com';

const CRYPTO_ALGO = 'aes-256-gcm';

function encryptToken(plaintext) {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY must be at least 32 chars to encrypt a GHL token');
  const key = Buffer.from(hex.slice(0, 32), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CRYPTO_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

// Each entry: { name, adAccountId, sheetTab, leadsSource?, ghlToken?, ghlLocationId? }
// leadsSource defaults to 'sheet' when GHL fields are omitted (unchanged
// behavior). Set leadsSource: 'ghl' + ghlToken + ghlLocationId to bulk-import
// a client already wired up for GHL leads/bookings from day one.
//
// Excludes 5 clients that already exist in prod (checked 2026-07-09):
// Stretch Zone Barnegat NJ, Discover Strength Cave Creek AZ,
// Arthur Murray Dance Studio Lexington KY, Bluprint Wellness CA,
// Renovate 4 Wellness Inc — see conversation notes for the Bluprint
// ad_account_id mismatch (prod has 1007481743408819, sheet says 226089669204751).
const CLIENTS = [
  { name: 'Ncognito Wellington: Massage & Fitness', adAccountId: '226089669204751', sheetTab: 'Ncognito Wellington: Massage & Fitness' },
  { name: 'Taylor Made Wellness, IN', adAccountId: '226089669204751', sheetTab: 'Taylor Made Wellness, IN' },
  { name: 'HBR Personal Training', adAccountId: '226089669204751', sheetTab: 'HBR Personal Training' },
  { name: 'Stretch Health & Wellness', adAccountId: '226089669204751', sheetTab: 'Stretch Health & Wellness' },
  { name: 'StretchLab St. John, IN', adAccountId: '226089669204751', sheetTab: 'StretchLab St. John, IN' },
  { name: 'StretchLab Crown Point, IN', adAccountId: '226089669204751', sheetTab: 'StretchLab Crown Point, IN' },
  { name: 'TX Black Belt Academy Burleson, TX', adAccountId: '226089669204751', sheetTab: 'TX Black Belt Academy Burleson, TX' },
  { name: 'Ncognito Wellington: STRETCH', adAccountId: '1007481743408819', sheetTab: 'Ncognito Wellington: STRETCH' },
  { name: 'Low Index Golf, FL', adAccountId: '226089669204751', sheetTab: 'Low Index Golf, FL' },
  { name: 'Yoga Nest Venice, CA', adAccountId: '1007481743408819', sheetTab: 'Yoga Nest Venice, CA' },
  { name: 'Piper Laine Fit, Tequesta, FL', adAccountId: '226089669204751', sheetTab: 'Piper Laine Fit, Tequesta, FL' },
  { name: 'BeMore Boot Camp, MD', adAccountId: '226089669204751', sheetTab: 'BeMore Boot Camp' },
];

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function randomPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

function sqlEscape(s) {
  return s.replace(/'/g, "''");
}

const rows = [];
const credentials = [];

for (const { name, adAccountId, sheetTab, leadsSource, ghlToken, ghlLocationId } of CLIENTS) {
  const email = `${slugify(name)}@${EMAIL_DOMAIN}`;
  const password = randomPassword();
  const hash = bcrypt.hashSync(password, 12);
  credentials.push({ name, email, password });

  const resolvedLeadsSource = leadsSource || 'sheet';
  const ghlTokenEnc = ghlToken ? encryptToken(ghlToken) : '';

  rows.push(`
-- ${name}
WITH new_client AS (
  INSERT INTO clients (name, ad_account_ids, sheet_id, sheet_tab, leads_source, ghl_token_enc, ghl_location_id, active)
  VALUES ('${sqlEscape(name)}', ARRAY['${adAccountId}'], '${SHEET_ID}', '${sqlEscape(sheetTab)}', '${resolvedLeadsSource}', '${sqlEscape(ghlTokenEnc)}', '${sqlEscape(ghlLocationId || '')}', true)
  RETURNING id
),
new_user AS (
  INSERT INTO users (email, password_hash, role)
  VALUES ('${email}', '${hash}', 'client')
  RETURNING id
)
INSERT INTO client_users (client_id, user_id)
SELECT new_client.id, new_user.id FROM new_client, new_user;`);
}

const nameList = CLIENTS.map(({ name }) => `'${sqlEscape(name)}'`).join(', ');

console.log('-- Verify these ad account IDs already exist in agency_bm_connections before running the inserts below:');
console.log(`-- SELECT label, account_ids FROM agency_bm_connections;`);
console.log(`-- Expected account IDs in use: 226089669204751, 1007481743408819`);
console.log();
console.log('BEGIN;');
console.log(`
-- Abort the whole transaction if any of these client names already exist,
-- so re-running this script never creates duplicates.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM clients WHERE name IN (${nameList})) THEN
    RAISE EXCEPTION 'One or more clients already exist — aborting to avoid duplicates';
  END IF;
END $$;
`);
console.log(rows.join('\n'));
console.log('COMMIT;');

console.error('\n=== Generated credentials (save this — passwords are not stored anywhere else) ===');
for (const c of credentials) {
  console.error(`${c.name.padEnd(45)} | ${c.email.padEnd(50)} | ${c.password}`);
}
