/**
 * Read-only reconciliation: per client (location), Meta LIVE vs CACHED totals side by side,
 * plus leads from the client's Google Sheet tab. Writes nothing to the DB or to Meta.
 *
 * Run (from portal/):
 *   railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_live_vs_cached.ts 2026-08-01 2026-08-31 <outDir>
 */
import { Pool } from 'pg'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { decrypt } from '../../src/lib/crypto'
import { fetchSheetRows } from '../../src/lib/sheets'

const GRAPH = 'https://graph.facebook.com/v22.0'
const SINCE = process.argv[2] || '2026-08-01'
const UNTIL = process.argv[3] || '2026-08-31'
const OUT_DIR = process.argv[4] || '.'
const NAME_PREFIX = (process.argv[5] || '').toLowerCase() // optional: only clients whose name starts with this
// optional: ';'-separated exact client names to include even when active=false (e.g. a spending location whose dashboard is off).
// Not ',' — client names contain commas ("Alloy Personal Training Edina, MN").
const EXTRA_INACTIVE = new Set((process.argv[6] || '').split(';').map(s => s.trim().toLowerCase()).filter(Boolean))
const ATTRIBUTION_WINDOWS = '["7d_click","1d_view","1d_ev"]'
const ALL_STATUSES = ['ACTIVE', 'PAUSED', 'DELETED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES']
const UNFILTERED_ACCOUNT_PREFIX = 'unfiltered:'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 })

// reach = Meta's unique reach per campaign for the whole range (summed across campaigns);
// reachDaily = sum of each day's reach, which is how the cached dashboard counts it.
type Totals = { spend: number; impressions: number; linkClicks: number; leads: number; reach: number; reachDaily: number }
type CampaignRow = Totals & { name: string }
const zero = (): Totals => ({ spend: 0, impressions: 0, linkClicks: 0, leads: 0, reach: 0, reachDaily: 0 })

// Copies of src/lib/meta.ts logic (importing meta.ts would pull in next-auth + db bootstrap DDL).
function matchesCampaignFilter(name: string, campaignFilter: string, accountId?: string): boolean {
  if (!campaignFilter) return true
  const segments = campaignFilter.split('|').map(s => s.trim()).filter(Boolean)
  const unfiltered = segments.filter(s => s.startsWith(UNFILTERED_ACCOUNT_PREFIX)).map(s => s.slice(UNFILTERED_ACCOUNT_PREFIX.length))
  if (accountId && unfiltered.includes(accountId)) return true
  const needles = segments.filter(s => !s.startsWith(UNFILTERED_ACCOUNT_PREFIX))
  if (needles.length === 0) return true
  const haystack = name.toLowerCase()
  return needles.some(n => haystack.includes(n.toLowerCase()))
}

function resolveResultsFromActions(actions: { action_type: string; value: string }[] | undefined, campaignName: string): number {
  if (!actions) return 0
  const m: Record<string, number> = {}
  for (const a of actions) m[a.action_type] = parseInt(a.value || '0', 10)
  const pixel = m['offsite_conversion.fb_pixel_lead'] || 0
  const onsite = m['onsite_conversion.lead_grouped'] || 0
  if (/instant form/i.test(campaignName) && onsite > 0) return onsite
  if (pixel > 0) return pixel
  if (onsite > 0) return onsite
  return m['lead'] || 0
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function graph(url: string, body?: URLSearchParams): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, body ? { method: 'POST', body } : undefined)
    const json: any = await res.json()
    const code = json?.error?.code
    if (json.error && [4, 17, 80000, 80004, 2].includes(code) && attempt <= 4) { await sleep(20000 * attempt); continue }
    return json
  }
}

async function fetchLive(accountId: string, token: string, daily = false): Promise<CampaignRow[]> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const start = await graph(`${GRAPH}/act_${accountId}/insights`, new URLSearchParams({
      level: 'campaign',
      fields: 'campaign_id,campaign_name,reach,impressions,spend,inline_link_clicks,actions',
      ...(daily ? { time_increment: '1' } : {}),
      time_range: JSON.stringify({ since: SINCE, until: UNTIL }),
      action_attribution_windows: ATTRIBUTION_WINDOWS,
      filtering: JSON.stringify([{ field: 'campaign.effective_status', operator: 'IN', value: ALL_STATUSES }]),
      access_token: token,
    }))
    if (start.error) throw new Error(`start: ${start.error.message} (code ${start.error.code}/${start.error.error_subcode ?? '-'})`)
    const runId = start.report_run_id
    let status = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 600_000) {
      const s = await graph(`${GRAPH}/${runId}?fields=async_status,async_percent_completion&access_token=${encodeURIComponent(token)}`)
      if (s.error) throw new Error(`poll: ${s.error.message}`)
      status = s.async_status
      if (status === 'Job Completed' || status === 'Job Failed' || status === 'Job Skipped') break
      await sleep(3000)
    }
    if (status !== 'Job Completed') { if (attempt === 2) throw new Error(`job ${status || 'timed out'}`); continue }

    const rows: CampaignRow[] = []
    let limit = 500
    let next: string | null = `${GRAPH}/${runId}/insights?limit=${limit}&access_token=${encodeURIComponent(token)}`
    while (next) {
      const page = await graph(next)
      if (page.error) {
        if (page.error.code === 1 && limit > 25) { limit = Math.max(25, Math.floor(limit / 2)); next = next.replace(/([?&])limit=\d+/, `$1limit=${limit}`); continue }
        throw new Error(`fetch: ${page.error.message}`)
      }
      for (const r of page.data || []) {
        rows.push({
          name: r.campaign_name || '',
          spend: parseFloat(r.spend || '0'),
          impressions: parseInt(r.impressions || '0', 10),
          linkClicks: parseInt(r.inline_link_clicks || '0', 10),
          leads: resolveResultsFromActions(r.actions, r.campaign_name || ''),
          reach: daily ? 0 : parseInt(r.reach || '0', 10),
          reachDaily: daily ? parseInt(r.reach || '0', 10) : 0,
        })
      }
      next = page.paging?.next || null
    }
    return rows
  }
  return []
}

async function fetchCached(accountId: string): Promise<CampaignRow[]> {
  const { rows } = await pool.query(
    `SELECT campaign_name, SUM(impressions)::text AS impressions, SUM(spend)::text AS spend, SUM(reach)::text AS reach,
            SUM(link_clicks)::text AS link_clicks, SUM(results)::text AS results
     FROM meta_daily_insights
     WHERE account_id = $1 AND level = 'campaign' AND date BETWEEN $2 AND $3
     GROUP BY campaign_name`, [accountId, SINCE, UNTIL])
  return rows.map(r => ({
    name: r.campaign_name || '', spend: parseFloat(r.spend || '0'), impressions: parseInt(r.impressions || '0', 10),
    linkClicks: parseInt(r.link_clicks || '0', 10), leads: parseInt(r.results || '0', 10),
    reach: 0, reachDaily: parseInt(r.reach || '0', 10),
  }))
}

function sumFor(rows: CampaignRow[] | undefined, filter: string, accountId: string): Totals {
  const t = zero()
  for (const r of rows || []) {
    if (!matchesCampaignFilter(r.name, filter, accountId)) continue
    t.spend += r.spend; t.impressions += r.impressions; t.linkClicks += r.linkClicks; t.leads += r.leads
    t.reach += r.reach; t.reachDaily += r.reachDaily
  }
  return t
}

async function main() {
  console.log(`Range ${SINCE} .. ${UNTIL}`)
  const clients = (await pool.query(
    `SELECT id, name, campaign_filter, ad_account_ids, leads_source, data_source, sheet_id, sheet_tab, active
     FROM clients ORDER BY name`)).rows.filter(c => !NAME_PREFIX || c.name.toLowerCase().startsWith(NAME_PREFIX))
    .map(c => (EXTRA_INACTIVE.has(c.name.toLowerCase()) ? { ...c, active: true, forcedInactive: true } : c))
  const conns = (await pool.query(`SELECT label, token_enc, account_ids, accounts_json FROM agency_bm_connections ORDER BY sort_order`)).rows
  const syncState = (await pool.query(`SELECT * FROM agency_meta_sync_state`)).rows

  const tokenFor: Record<string, string> = {}
  const bmFor: Record<string, string> = {}
  const accountName: Record<string, string> = {}
  const allAccounts: string[] = []
  for (const c of conns) {
    const token = decrypt(c.token_enc)
    for (const id of c.account_ids || []) { tokenFor[id] = token; bmFor[id] = c.label; allAccounts.push(id) }
    for (const a of (Array.isArray(c.accounts_json) ? c.accounts_json : [])) {
      const id = String(a.account_id || a.id || '').replace(/^act_/, '')
      if (id) accountName[id] = a.name || ''
    }
  }

  const accountsOf = (c: any): string[] => (c.ad_account_ids?.length ? c.ad_account_ids : allAccounts)
  // Every client's accounts, not just active ones: a client deactivated partway
  // through the range still spent money inside it, and dropping its account here
  // would make that spend unfetchable below (2026-09-18 lesson: an
  // inactive-but-spending client reads as "no dashboard" and silently
  // under-reports the total).
  const needed = Array.from(new Set(clients.flatMap(accountsOf))) as string[]
  console.log(`${clients.length} clients (${clients.filter(c => c.active).length} active), ${needed.length} ad accounts`)

  const live: Record<string, CampaignRow[]> = {}
  const cached: Record<string, CampaignRow[]> = {}
  const liveError: Record<string, string> = {}
  for (const acct of needed) {
    cached[acct] = await fetchCached(acct)
    const t0 = Date.now()
    try {
      if (!tokenFor[acct]) throw new Error('no BM connection/token for this account')
      live[acct] = await fetchLive(acct, tokenFor[acct])
      // second pull, one row per campaign per day, only to get the sum-of-daily reach
      const daily = await fetchLive(acct, tokenFor[acct], true)
      live[acct] = live[acct].concat(daily.map(r => ({ ...r, spend: 0, impressions: 0, linkClicks: 0, leads: 0 })))
    } catch (e: any) { liveError[acct] = e.message }
    const l = sumFor(live[acct], '', acct), c = sumFor(cached[acct], '', acct)
    console.log(`  ${acct} ${accountName[acct] || ''} | live ${liveError[acct] ? 'ERROR ' + liveError[acct] : `${live[acct].length} campaigns $${l.spend.toFixed(2)}`} | cached ${cached[acct].length} campaigns $${c.spend.toFixed(2)} | ${Math.round((Date.now() - t0) / 1000)}s`)
  }

  const out: any[] = []
  // Inactive clients are kept only when they actually spent inside the range
  // (dropped further down); an inactive client with no spend is just noise.
  for (const c of clients) {
    const accts = accountsOf(c)
    const L = zero(), C = zero()
    const errs: string[] = []
    for (const a of accts) {
      if (liveError[a]) errs.push(`${a}: ${liveError[a]}`)
      const l = sumFor(live[a], c.campaign_filter || '', a), k = sumFor(cached[a], c.campaign_filter || '', a)
      L.spend += l.spend; L.impressions += l.impressions; L.linkClicks += l.linkClicks; L.leads += l.leads; L.reach += l.reach; L.reachDaily += l.reachDaily
      C.spend += k.spend; C.impressions += k.impressions; C.linkClicks += k.linkClicks; C.leads += k.leads; C.reachDaily += k.reachDaily
    }
    let sheetLeads: number | null = null
    let sheetNote = ''
    if (c.sheet_id && c.sheet_tab) {
      try {
        const res = await fetchSheetRows(c.sheet_id, c.sheet_tab)
        sheetLeads = res.rows.filter(r => r.day >= SINCE && r.day <= UNTIL).reduce((s, r) => s + (r.leads || 0), 0)
        if (res.failedTabs.length) sheetNote = `failed tabs: ${res.failedTabs.join(', ')}`
      } catch (e: any) { sheetNote = `sheet error: ${e.code || ''} ${e.message}`.slice(0, 120) }
    }
    if (!c.active && L.spend === 0 && C.spend === 0 && !sheetLeads) continue
    out.push({
      name: c.name, active: c.active, forcedInactive: !!c.forcedInactive, accounts: accts, bm: Array.from(new Set(accts.map((a: string) => bmFor[a] || '?'))).join('+'),
      data_source: c.data_source, leads_source: c.leads_source, filter: c.campaign_filter || '',
      live: L, cached: C, liveError: errs.join('; '), sheetLeads, sheetNote,
    })
  }

  writeFileSync(join(OUT_DIR, `live_vs_cached_${SINCE}_${UNTIL}.json`), JSON.stringify({
    since: SINCE, until: UNTIL, generatedAt: new Date().toISOString(), accountName, bmFor, liveError,
    syncState: syncState.map(s => ({ ...s })),
    accountTotals: needed.map(a => ({ account: a, name: accountName[a] || '', live: liveError[a] ? null : sumFor(live[a], '', a), cached: sumFor(cached[a], '', a), liveCampaigns: live[a]?.length ?? null, cachedCampaigns: cached[a].length })),
    clients: out,
  }, null, 2))
  console.log(`wrote ${out.length} client rows`)
  await pool.end()
}

main().catch(async e => { console.error('FATAL', e); await pool.end(); process.exit(1) })
