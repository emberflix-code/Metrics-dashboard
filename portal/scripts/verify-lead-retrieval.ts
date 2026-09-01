/**
 * Verifies whether Meta instant-form (lead-gen) LEAD CONTENT is retrievable
 * for a given client, before building the "show lead names" feature.
 *
 * Insights (spend/impressions/results) come from the ad account and work with
 * ads_read. Lead CONTENT (name/email/phone) lives on the PAGE that owns the
 * instant form, and needs BOTH the leads_retrieval permission AND a token
 * with a role on that Page. This script reports exactly which half is missing.
 *
 * Run:  railway run npx tsx portal/scripts/verify-lead-retrieval.ts [clientName]
 *
 * Read-only: performs GETs against the Graph API and the DB. Writes nothing.
 */
import { Pool } from 'pg'
import { decrypt } from '../src/lib/crypto'
import { matchesCampaignFilter } from '../src/lib/meta'

const GRAPH = 'https://graph.facebook.com/v21.0'
const CLIENT_NAME = process.argv[2] || 'CycleBar Redmond'
const SINCE = process.argv[3] || '2026-08-01'
const UNTIL = process.argv[4] || '2026-09-01'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

type Json = Record<string, any>
const get = async (path: string, params: Record<string, string>): Promise<Json> => {
  const u = new URL(`${GRAPH}/${path}`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  try { return await (await fetch(u.toString())).json() } catch (e: any) { return { error: { message: e.message } } }
}
const ok = (s: string) => console.log(`  \x1b[32mPASS\x1b[0m ${s}`)
const bad = (s: string) => console.log(`  \x1b[31mFAIL\x1b[0m ${s}`)
const info = (s: string) => console.log(`       ${s}`)

async function main() {
  console.log(`\n=== Lead-retrieval readiness: ${CLIENT_NAME} (${SINCE} .. ${UNTIL}) ===\n`)

  const [client] = (await pool.query(
    `SELECT id, name, campaign_filter, ad_account_ids, leads_source FROM clients WHERE name = $1`, [CLIENT_NAME])).rows
  if (!client) { console.log('Client not found'); return }
  console.log(`Client: ${client.name} | leads_source=${client.leads_source} | filter="${client.campaign_filter}"`)
  console.log(`Accounts: ${(client.ad_account_ids || []).join(', ')}\n`)

  console.log('[1] Ad-account token')
  const [bm] = (await pool.query(
    `SELECT token_enc FROM agency_bm_connections WHERE $1 && account_ids LIMIT 1`, [client.ad_account_ids])).rows
  if (!bm) { bad('no BM connection covers these accounts'); return }
  const adToken = decrypt(bm.token_enc)
  const perms = await get('me/permissions', { access_token: adToken })
  const granted: string[] = (perms.data || []).filter((p: Json) => p.status === 'granted').map((p: Json) => p.permission)
  granted.includes('leads_retrieval')
    ? ok('leads_retrieval granted')
    : bad('leads_retrieval NOT granted -> re-auth the System User with this scope')
  granted.includes('pages_manage_ads')
    ? ok('pages_manage_ads granted')
    : bad('pages_manage_ads NOT granted -> System User has no Page role yet')

  console.log('\n[2] Page token (agency_page_token id=1)')
  const [pt] = (await pool.query(`SELECT token_enc FROM agency_page_token WHERE id = 1`)).rows
  const pageToken = pt?.token_enc ? decrypt(pt.token_enc) : null
  if (pageToken) {
    ok('page token configured')
    const me = await get('me/accounts', { access_token: pageToken, fields: 'id,name', limit: '100' })
    info(`page token sees ${(me.data || []).length} page(s)`)
  } else {
    bad('no page token stored -> Admin > Settings > Page token')
  }

  console.log('\n[3] Discovering instant forms from live ads')
  const formIds = new Map<string, string>()  // formId -> ad name
  for (const acct of client.ad_account_ids || []) {
    const ins = await get(`act_${acct}/insights`, {
      access_token: adToken, level: 'campaign', fields: 'campaign_id,campaign_name',
      time_range: JSON.stringify({ since: SINCE, until: UNTIL }), limit: '200',
    })
    for (const row of ins.data || []) {
      if (!matchesCampaignFilter(row.campaign_name || '', client.campaign_filter)) continue
      const ads = await get(`${row.campaign_id}/ads`, {
        access_token: adToken, limit: '50',
        fields: 'id,name,creative{object_story_spec,asset_feed_spec}',
      })
      for (const ad of ads.data || []) {
        const cr = ad.creative || {}
        const ctas = [
          ...(cr.asset_feed_spec?.call_to_actions || []),
          cr.object_story_spec?.link_data?.call_to_action,
          cr.object_story_spec?.video_data?.call_to_action,
        ].filter(Boolean)
        for (const cta of ctas) {
          const fid = cta?.value?.lead_gen_form_id
          if (fid) formIds.set(String(fid), ad.name)
        }
      }
    }
  }
  if (!formIds.size) { bad('no instant-form IDs found on ads in this range'); return }
  ok(`found ${formIds.size} form id(s)`)
  for (const [fid, adName] of Array.from(formIds.entries())) info(`form ${fid}  (via ad "${adName}")`)

  console.log('\n[4] Attempting lead retrieval')
  let anySuccess = false
  for (const [fid, adName] of Array.from(formIds.entries())) {
    for (const [label, tok] of [['ad token', adToken], ['page token', pageToken]] as [string, string | null][]) {
      if (!tok) continue
      const r = await get(`${fid}/leads`, { access_token: tok, fields: 'id,created_time,field_data', limit: '5' })
      if (r.error) {
        const e = r.error
        bad(`form ${fid} via ${label}: ${e.message} (code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})`)
        if (e.code === 100 && e.error_subcode === 33) info('  -> token has no role on the Page that owns this form')
        if (e.code === 200) info('  -> needs pages_manage_ads on a Page-scoped token')
      } else {
        anySuccess = true
        ok(`form ${fid} via ${label}: ${(r.data || []).length} lead(s) readable  [ad "${adName}"]`)
        for (const l of (r.data || []).slice(0, 3)) {
          const m: Json = {}
          for (const f of l.field_data || []) m[f.name] = (f.values || []).join(',')
          info(`  ${l.created_time}  ${m.full_name || m.first_name || '?'}  ${m.email || '-'}  ${m.phone_number || '-'}`)
        }
      }
    }
  }

  console.log('\n=== VERDICT ===')
  if (anySuccess) {
    console.log('READY — lead content is retrievable. The feature can be built against this path.')
  } else {
    console.log('BLOCKED — no token can read lead content yet.')
    console.log('Fix: in Business Settings, assign the System User to the Page that owns the form')
    console.log('     (Pages > [page] > Add People) with Ads access, then re-run this script.')
  }
  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
