/**
 * Read-only lead-gen snapshot for one client (or one ad account) from the cached Meta DB.
 * Writes nothing to the DB or to Meta. Output: one JSON document for the analysis step.
 *
 * Run from portal/ (so `pg` resolves from portal/node_modules):
 *   railway run --service Metrics-dashboard npx --yes tsx ../.claude/skills/meta-leadgen-optimization/scripts/leadgen_snapshot.ts \
 *     --client "Alloy Windermere" [--since 2026-09-01 --until 2026-09-28] [--out <file.json>]
 *   ... --account 4594093867301854          (whole account, no campaign filter)
 *   ... --live                              (also GET budgets/CBO, bid strategy, objective, learning stage from Meta)
 *   ... --client "Alloy" --list             (just list matching client rows)
 *   ... --client <client uuid>              (exact row, when names are duplicated)
 *   ... --triage "Alloy"                    (one row per active non-rollup client matching the name, worst first)
 *
 * Defaults: until = yesterday in America/New_York, since = until - 13 days (14-day window),
 * prior period = same length immediately before `since`.
 */
import { createRequire } from 'module'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { writeFileSync } from 'fs'
import { createDecipheriv } from 'crypto'

const require = createRequire(join(process.cwd(), 'package.json'))
const { Pool } = require('pg')

const args = process.argv.slice(2)
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const flag = (name: string) => args.includes(`--${name}`)

const UNFILTERED_ACCOUNT_PREFIX = 'unfiltered:'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 })

// ---------- dates ----------
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d) }
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1
function yesterdayNY(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return addDays(today, -1)
}

// ---------- helpers ----------
// Copy of portal/src/lib/crypto.ts decrypt (aes-256-gcm, iv:tag:ciphertext hex).
function decrypt(stored: string): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY
  if (!key || key.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY missing (run via railway run)')
  const [iv, tag, enc] = stored.split(':').map(h => Buffer.from(h, 'hex'))
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key.slice(0, 32), 'utf8'), iv)
  d.setAuthTag(tag)
  return d.update(enc).toString('utf8') + d.final('utf8')
}

function matchesCampaignFilter(name: string, campaignFilter: string, accountId?: string): boolean {
  if (!campaignFilter) return true
  const segments = campaignFilter.split('|').map(s => s.trim()).filter(Boolean)
  const unfiltered = segments.filter(s => s.startsWith(UNFILTERED_ACCOUNT_PREFIX)).map(s => s.slice(UNFILTERED_ACCOUNT_PREFIX.length))
  if (accountId && unfiltered.includes(accountId)) return true
  const needles = segments.filter(s => !s.startsWith(UNFILTERED_ACCOUNT_PREFIX))
  if (needles.length === 0) return true
  const haystack = (name || '').toLowerCase()
  return needles.some(n => haystack.includes(n.toLowerCase()))
}

type Agg = { spend: number; impressions: number; reachDaily: number; linkClicks: number; results: number; days: Set<string> }
const zero = (): Agg => ({ spend: 0, impressions: 0, reachDaily: 0, linkClicks: 0, results: 0, days: new Set() })
function add(a: Agg, r: any) {
  a.spend += Number(r.spend) || 0
  a.impressions += Number(r.impressions) || 0
  a.reachDaily += Number(r.reach) || 0
  a.linkClicks += Number(r.link_clicks) || 0
  a.results += Number(r.results) || 0
  if (Number(r.spend) > 0) a.days.add(String(r.date))
}
// Last date with spend: separates "still burning money" from "spent earlier in the window, already paused".
const lastSpend = (a: Agg) => ([...a.days].sort().pop() ?? null)
const round = (n: number, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
function metrics(a: Agg) {
  return {
    spend: round(a.spend),
    impressions: a.impressions,
    link_clicks: a.linkClicks,
    results: a.results,
    cpl: a.results ? round(a.spend / a.results) : null,
    ctr_pct: a.impressions ? round((a.linkClicks / a.impressions) * 100) : null,
    cpm: a.impressions ? round((a.spend / a.impressions) * 1000) : null,
    cpc: a.linkClicks ? round(a.spend / a.linkClicks) : null,
    click_to_lead_pct: a.linkClicks ? round((a.results / a.linkClicks) * 100) : null,
    // Sum of daily reach overstates unique reach, so this is an average DAILY frequency, not period frequency.
    avg_daily_freq: a.reachDaily ? round(a.impressions / a.reachDaily) : null,
    active_days: a.days.size,
    last_spend_date: lastSpend(a),
  }
}
const pctChange = (cur: number | null, prev: number | null) => (cur != null && prev ? round(((cur - prev) / prev) * 100, 1) : null)
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) }

// ---------- client-side lead source (sheet / GHL), counted exactly like the dashboard ----------
// Reuses portal/src/lib/sheets.ts + ghl.ts (neither imports db/next), so counts match the Leads card.
const libUrl = (f: string) => pathToFileURL(join(process.cwd(), 'src', 'lib', f)).href
let _libs: Promise<{ sheets: any; ghl: any }> | null = null
const libs = () => (_libs ||= Promise.all([import(libUrl('sheets.ts')), import(libUrl('ghl.ts'))]).then(([sheets, ghl]) => ({ sheets, ghl })))

// Same resolver as dashboard/page.tsx: ghl (needs token) -> sheet (needs tab) -> ghl-without-token falls back to sheet -> meta.
function resolveLeadsSource(c: any): 'meta' | 'sheet' | 'ghl' {
  const req = c.leads_source || 'meta'
  if (req === 'ghl' && c.ghl_token_enc) return 'ghl'
  if (req === 'sheet' && c.sheet_tab) return 'sheet'
  if (req === 'ghl' && c.sheet_tab) return 'sheet'
  return 'meta'
}

type Win = { since: string; until: string; priorSince: string; priorUntil: string }
const inWin = (d: string, a: string, b: string) => d >= a && d <= b

async function accountTimezone(accountIds: string[], conns: any[]): Promise<string> {
  // Like getClientConnection().accountIds[0]: first client account in BM-connection sort order.
  for (const conn of conns) for (const acct of accountIds) {
    if (!(conn.account_ids || []).map(String).includes(acct)) continue
    try {
      const j: any = await (await fetch(`https://graph.facebook.com/v22.0/act_${acct}?fields=timezone_name&access_token=${encodeURIComponent(decrypt(conn.token_enc))}`)).json()
      return j.timezone_name || 'UTC'
    } catch { return 'UTC' }
  }
  return 'UTC'
}

/**
 * Leads as the client's dashboard counts them, plus per-campaign attribution:
 * - sheet: rows summed per sheet "Campaign Name", joined to Meta campaigns by EXACT name (as the campaigns table does).
 * - ghl: qualifying contacts (Leads Tag rule), attributed via attributionSource.campaign (= Meta campaign ID);
 *   form-submission utm_campaign kept as secondary evidence. The dashboard itself never attributes GHL leads
 *   per campaign; this is the skill's own cross-check.
 * Both are computed whenever configured (not only the resolved source) so they can cross-check each other.
 */
async function clientLeads(c: any, accountIds: string[], w: Win, conns: any[], opts: { perLead: boolean }) {
  const resolved = resolveLeadsSource(c)
  const out: any = {
    configured: c.leads_source || 'meta', resolved,
    warnings: [] as string[],
  }
  if (resolved === 'sheet' && c.use_sheet_for_leads === false)
    out.warnings.push('leads_source resolves to sheet but legacy use_sheet_for_leads=false: /api/sheets/meta returns enabled:false, so the dashboard actually shows META leads.')
  if (c.leads_source === 'ghl' && !c.ghl_token_enc) out.warnings.push('leads_source=ghl but no GHL token: dashboard falls back to ' + resolved + '.')

  // Every Meta campaign name/ID in the client's accounts (names for sheet matching, IDs for GHL attribution).
  const metaCamps = (await pool.query(
    `SELECT DISTINCT ON (entity_id) entity_id AS id, name, account_id FROM meta_entities WHERE level = 'campaign' AND account_id = ANY($1)`, [accountIds])).rows
  const idByName = new Map<string, string>(); for (const m of metaCamps) if (!idByName.has(m.name)) idByName.set(m.name, m.id)
  const nameById = new Map<string, string>(metaCamps.map((m: any) => [m.id, m.name]))
  const inFilter = (name: string, acct?: string) => matchesCampaignFilter(name, c.campaign_filter || '', acct)
  const { sheets, ghl } = await libs()

  if (c.sheet_id && c.sheet_tab) {
    try {
      const res = await sheets.fetchSheetRows(c.sheet_id, c.sheet_tab)
      const by = new Map<string, { cur: number; prior: number }>()
      let cur = 0, prior = 0
      for (const r of res.rows) {
        const isCur = inWin(r.day, w.since, w.until), isPrior = inWin(r.day, w.priorSince, w.priorUntil)
        if (!isCur && !isPrior) continue
        const e = by.get(r.campaign) || { cur: 0, prior: 0 }
        if (isCur) { e.cur += r.leads || 0; cur += r.leads || 0 } else { e.prior += r.leads || 0; prior += r.leads || 0 }
        by.set(r.campaign, e)
      }
      const rows = [...by.entries()].filter(([, e]) => e.cur || e.prior).map(([name, e]) => ({
        sheet_campaign: name, leads: e.cur, prior_leads: e.prior,
        meta_campaign_id: idByName.get(name) ?? null, // exact, case-sensitive — the dashboard's join
        in_campaign_filter: inFilter(name),
      })).sort((a, b) => b.leads - a.leads)
      out.sheet = {
        tabs: c.sheet_tab, failed_tabs: res.failedTabs, leads: cur, prior_leads: prior,
        note: 'Leads card = sum of ALL rows on these tabs for the dates (campaign_filter is not applied).',
        unmatched_leads: rows.filter(r => !r.meta_campaign_id).reduce((s, r) => s + r.leads, 0),
        outside_filter_leads: rows.filter(r => !r.in_campaign_filter).reduce((s, r) => s + r.leads, 0),
        by_campaign: rows,
      }
    } catch (e: any) { out.sheet = { error: `${e.code || ''} ${e.message}`.trim() } }
  }

  if (c.ghl_token_enc) {
    try {
      const token = decrypt(c.ghl_token_enc)
      const loc = c.ghl_location_id || undefined
      const [leadsRes, subsRes] = await Promise.all([ghl.fetchGhlLeads({ token, locationId: loc }), ghl.fetchGhlFormSubmissions({ token, locationId: loc })])
      const tz = await accountTimezone(accountIds, conns)
      const tag = c.ghl_leads_tag || ''
      const byContact = new Map<string, any>(leadsRes.rows.map((r: any) => [r.contactId, r]))
      const utmByContact = new Map<string, Set<string>>()
      for (const s of subsRes.rows) if (s.campaignId) { const u = utmByContact.get(s.contactId) || new Set(); u.add(s.campaignId); utmByContact.set(s.contactId, u) }
      // Same algorithm as /api/ghl/leads, run for both windows.
      const count = (a: string, b: string) => {
        const seen = new Map<string, string>()
        for (const r of leadsRes.rows) { if (seen.has(r.contactId) || !ghl.isQualifyingLead(r, tag)) continue; const d = ghl.dayInTimezone(r.date, tz); if (inWin(d, a, b)) seen.set(r.contactId, d) }
        for (const s of subsRes.rows) { if (seen.has(s.contactId)) continue; const ct = byContact.get(s.contactId); if (!ct || !ghl.isQualifyingLead(ct, tag)) continue; const d = ghl.dayInTimezone(s.date, tz); if (inWin(d, a, b)) seen.set(s.contactId, d) }
        return seen
      }
      const cur = count(w.since, w.until), prior = count(w.priorSince, w.priorUntil)
      const clientCampIds = new Set(metaCamps.filter((m: any) => inFilter(m.name, m.account_id)).map((m: any) => m.id))
      const by = new Map<string, { leads: number; prior: number; booked: number }>()
      const bump = (seen: Map<string, string>, key: 'leads' | 'prior') => {
        for (const id of seen.keys()) {
          const ct = byContact.get(id); const cid = ct?.campaignId || '(unattributed)'
          const e = by.get(cid) || { leads: 0, prior: 0, booked: 0 }
          e[key]++
          if (key === 'leads' && ct?.tags?.some((t: string) => t.toLowerCase() === 'booked appointment')) e.booked++
          by.set(cid, e)
        }
      }
      bump(cur, 'leads'); bump(prior, 'prior')
      const rows = [...by.entries()].map(([cid, e]) => ({
        meta_campaign_id: cid === '(unattributed)' ? null : cid,
        meta_campaign_name: nameById.get(cid) ?? null,
        belongs_to_client: cid !== '(unattributed)' && clientCampIds.has(cid),
        leads: e.leads, prior_leads: e.prior, booked: e.booked,
      })).sort((a, b) => b.leads - a.leads)
      out.ghl = {
        timezone: tz, leads_tag: tag || '(none: any contact with attributionSource.campaign qualifies)',
        contacts_scanned: leadsRes.contactsScanned, leads: cur.size, prior_leads: prior.size,
        unattributed_leads: rows.filter(r => !r.meta_campaign_id).reduce((s, r) => s + r.leads, 0),
        other_campaign_leads: rows.filter(r => r.meta_campaign_id && !r.belongs_to_client).reduce((s, r) => s + r.leads, 0),
        by_campaign: rows,
        per_lead: opts.perLead ? [...cur.entries()].sort(([, a], [, b]) => b.localeCompare(a)).map(([id, day]) => {
          const ct = byContact.get(id)
          return { day, contact_id: id, attribution_campaign_id: ct?.campaignId || null, attribution_campaign: nameById.get(ct?.campaignId) ?? null,
                   form_utm_campaign: [...(utmByContact.get(id) || [])], booked: !!ct?.tags?.some((t: string) => t.toLowerCase() === 'booked appointment') }
        }) : undefined,
      }
      // The search sends no sort, so check the dates actually scanned rather than assume which end the cap cut.
      const scannedDays = leadsRes.rows.map((r: any) => String(r.date).slice(0, 10)).sort()
      out.ghl.scanned_date_range = { oldest: scannedDays[0] ?? null, newest: scannedDays[scannedDays.length - 1] ?? null }
      if (leadsRes.contactsScanned >= 5000 && (scannedDays[0] ?? '') > w.priorSince)
        out.warnings.push(`GHL scan hit the 5,000-contact cap and the oldest contact scanned (${scannedDays[0]}) is inside the analysis window: counts are truncated (the dashboard has the same cap).`)
    } catch (e: any) { out.ghl = { error: `${e.code || ''} ${e.message}`.trim() } }
  }

  const pick = resolved === 'sheet' ? out.sheet : resolved === 'ghl' ? out.ghl : null
  out.dashboard_leads = pick && !pick.error ? { leads: pick.leads, prior_leads: pick.prior_leads } : null
  return out
}

// Agency-wide campaign CPLs for the period (>= $100 and >= 3 results), overall and per offer.
async function loadBenchmark(since: string, until: string) {
  const bench = (await pool.query(
    `SELECT i.campaign_id, COALESCE(o.offer, e.offer_token, 'Unknown') AS offer, SUM(i.spend) AS spend, SUM(i.results) AS results
       FROM meta_daily_insights i
       LEFT JOIN meta_entities e ON e.account_id = i.account_id AND e.level = 'campaign' AND e.entity_id = i.campaign_id
       LEFT JOIN campaign_offer_overrides o ON o.account_id = i.account_id AND o.campaign_id = i.campaign_id
      WHERE i.level = 'campaign' AND i.date BETWEEN $1 AND $2
      GROUP BY 1, 2 HAVING SUM(i.spend) >= 100 AND SUM(i.results) >= 3`, [since, until])).rows
  const cpls = bench.map((b: any) => Number(b.spend) / Number(b.results))
  const byOffer = new Map<string, number[]>()
  for (const b of bench) { const l = byOffer.get(b.offer) || []; l.push(Number(b.spend) / Number(b.results)); byOffer.set(b.offer, l) }
  return { bench, cpls, byOffer }
}

// Multi-location triage: one compact row per active, non-rollup client whose name matches, ranked by
// money that looks wasted on campaigns that are STILL spending. Drill into flagged ones with --client.
async function triage(q: string, since: string, until: string, priorSince: string) {
  const clients = (await pool.query(
    `SELECT id, name, ad_account_ids, campaign_filter, leads_source, sheet_id, sheet_tab, ghl_token_enc, ghl_location_id, ghl_leads_tag, use_sheet_for_leads FROM clients
      WHERE name ILIKE $1 AND active AND NOT COALESCE(is_rollup, false) ORDER BY name`, [`%${q}%`])).rows
  const accountIds = [...new Set(clients.flatMap((c: any) => (c.ad_account_ids || []).map(String)))]
  const rows = (await pool.query(
    `SELECT account_id, campaign_id, campaign_name, date::text AS date, spend, impressions, reach, link_clicks, results
       FROM meta_daily_insights WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3`,
    [accountIds, priorSince, until])).rows
  const ents = new Map<string, any>((await pool.query(
    `SELECT entity_id, effective_status, offer_token FROM meta_entities WHERE account_id = ANY($1) AND level = 'campaign'`,
    [accountIds])).rows.map((e: any) => [e.entity_id, e]))
  const sync = (await pool.query(
    `SELECT account_id, status, last_success_until, adset_insights_until, ad_insights_until FROM agency_meta_sync_state WHERE account_id = ANY($1)`,
    [accountIds])).rows
  const { cpls, byOffer } = await loadBenchmark(since, until)
  const overall = median(cpls)
  // A campaign counts as "still spending" if it spent on either of the last 2 days of the window.
  const recent = addDays(until, -1)

  const out = clients.map((c: any) => {
    const cur = zero(), prev = zero()
    const camps = new Map<string, { account_id: string; name: string; cur: Agg }>()
    const days = new Map<string, Agg>()
    for (const r of rows) {
      if (!matchesCampaignFilter(r.campaign_name, c.campaign_filter || '', r.account_id)) continue
      if (!(c.ad_account_ids || []).map(String).includes(r.account_id)) continue
      if (r.date >= since) {
        add(cur, r)
        const cm = camps.get(r.campaign_id) || { account_id: r.account_id, name: r.campaign_name, cur: zero() }
        add(cm.cur, r); camps.set(r.campaign_id, cm)
        const d = days.get(r.date) || zero(); add(d, r); days.set(r.date, d)
      } else add(prev, r)
    }
    // Target CPL: benchmark for the offer carrying the most spend, else agency median.
    const top = [...camps.entries()].sort(([, a], [, b]) => b.cur.spend - a.cur.spend)[0]
    const offer = top ? ents.get(top[0])?.offer_token ?? null : null
    const offerList = offer ? byOffer.get(offer) : undefined
    const target = offerList && offerList.length >= 3 ? median(offerList)! : overall
    const m = metrics(cur)
    const avgDay = cur.days.size ? cur.spend / cur.days.size : 0
    const zeroLeadDays = [...days.values()].filter(d => d.results === 0 && d.spend >= 0.5 * avgDay).length
    const flagged = [...camps.entries()].map(([id, cm]) => {
      const cmm = metrics(cm.cur)
      const stillSpending = (cmm.last_spend_date ?? '') >= recent
      const zeroLead = target != null && cm.cur.results === 0 && cm.cur.spend >= 2 * target
      const expensive = target != null && cm.cur.spend >= 3 * target && (cmm.cpl ?? 0) >= 2 * target
      return (zeroLead || expensive) ? {
        id, account_id: cm.account_id, name: cm.name, db_status: ents.get(id)?.effective_status ?? null,
        still_spending: stillSpending, reason: zeroLead ? '0 results >= 2x target spend' : 'CPL >= 2x target on >= 3x target spend',
        spend: cmm.spend, results: cmm.results, cpl: cmm.cpl, last_spend_date: cmm.last_spend_date,
      } : null
    }).filter(Boolean) as any[]
    const flaggedLive = flagged.filter(f => f.still_spending).reduce((s, f) => s + (f.spend || 0), 0)
    const flags: string[] = []
    if (cur.spend === 0) flags.push(prev.spend > 0 ? 'stopped_spending' : 'no_spend_check_campaign_filter')
    if (m.cpl != null && target != null && m.cpl >= 1.5 * target) flags.push(`cpl_${round(m.cpl / target, 1)}x_target`)
    if (flagged.some(f => f.still_spending)) flags.push('waste_campaign_live')
    if (zeroLeadDays >= 2) flags.push(`${zeroLeadDays}_zero_lead_days`)
    if (camps.size >= 3) flags.push(`${camps.size}_campaigns_spent`)
    return {
      client: c.name, client_id: c.id, leads_source: c.leads_source, offer, target_cpl: target,
      spend: m.spend, results: m.results, cpl: m.cpl, prior_cpl: metrics(prev).cpl, prior_active_days: prev.days.size,
      ctr_pct: m.ctr_pct, click_to_lead_pct: m.click_to_lead_pct, prior_click_to_lead_pct: metrics(prev).click_to_lead_pct,
      zero_lead_days: zeroLeadDays, campaigns_spent: camps.size, flagged_live_spend: round(flaggedLive), flags, flagged_campaigns: flagged,
    }
  })
  // Client-side leads (sheet/GHL) per location, 5 at a time; skip with --meta-only.
  if (!flag('meta-only')) {
    const conns = (await pool.query(`SELECT token_enc, account_ids FROM agency_bm_connections ORDER BY sort_order NULLS LAST`)).rows
    const priorUntil = addDays(since, -1)
    const queue = clients.map((c: any, i: number) => ({ c, row: out[i] }))
    await Promise.all(Array.from({ length: 5 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { c, row } = job
        const cl = await clientLeads(c, (c.ad_account_ids || []).map(String), { since, until, priorSince, priorUntil }, conns, { perLead: false })
        const src = cl.resolved === 'sheet' ? cl.sheet : cl.resolved === 'ghl' ? cl.ghl : null
        row.lead_source = cl.resolved
        row.client_leads = cl.dashboard_leads?.leads ?? null
        row.client_prior_leads = cl.dashboard_leads?.prior_leads ?? null
        row.client_cpl = row.client_leads ? round(row.spend / row.client_leads) : null
        row.meta_vs_client_gap_pct = row.client_leads ? round(((row.results - row.client_leads) / row.client_leads) * 100, 1) : null
        row.lead_source_detail = src?.error ? { error: src.error } : {
          unmatched_or_unattributed: cl.resolved === 'sheet' ? src?.unmatched_leads : src?.unattributed_leads,
          outside_client: cl.resolved === 'sheet' ? src?.outside_filter_leads : src?.other_campaign_leads,
        }
        if (cl.ghl && cl.resolved !== 'ghl' && !cl.ghl.error) row.ghl_cross_check_leads = cl.ghl.leads
        if (cl.warnings.length) row.lead_warnings = cl.warnings
        if (cl.resolved !== 'meta' && row.client_leads != null && row.client_cpl != null && row.target_cpl && row.client_cpl >= 1.5 * row.target_cpl && !(row.cpl >= 1.5 * row.target_cpl))
          row.flags.push('client_leads_worse_than_meta')
        if (row.meta_vs_client_gap_pct != null && Math.abs(row.meta_vs_client_gap_pct) >= 20) row.flags.push(`meta_vs_${cl.resolved}_gap_${row.meta_vs_client_gap_pct}%`)
      }
    }))
  }
  // Worst first: live waste, then CPL vs target.
  out.sort((a: any, b: any) => (b.flagged_live_spend - a.flagged_live_spend) || ((b.cpl ?? 0) / (b.target_cpl || 1) - (a.cpl ?? 0) / (a.target_cpl || 1)))
  return {
    generated_at: new Date().toISOString(),
    mode: 'triage', query: q, period: { since, until, prior_since: priorSince },
    note: 'Campaign-level only, cached DB. Drill into flagged clients with --client "<client_id>" --live. still_spending = spent on one of the last 2 days.',
    sync, benchmark: { median_cpl: overall, by_offer: [...byOffer.entries()].filter(([, l]) => l.length >= 3).map(([offer, l]) => ({ offer, campaigns: l.length, median_cpl: median(l) })) },
    clients: out,
  }
}

async function main() {
  if (arg('triage')) {
    const until = arg('until') || yesterdayNY()
    const since = arg('since') || addDays(until, -13)
    const len = daysBetween(since, until)
    const out = await triage(arg('triage')!, since, until, addDays(since, -len))
    const json = JSON.stringify(out, null, 2)
    const outPath = arg('out')
    if (outPath) { writeFileSync(outPath, json); console.log(`wrote ${outPath} (${out.clients.length} clients)`) } else console.log(json)
    return
  }
  const clientQ = arg('client')
  const accountQ = arg('account')
  if (!clientQ && !accountQ) throw new Error('Pass --client "<name substring>" (optionally with --list) or --account <id>')

  // ---------- scope ----------
  const nameById = new Map<string, string>()
  for (const c of (await pool.query(`SELECT accounts_json FROM agency_bm_connections`)).rows)
    for (const a of c.accounts_json || []) if (a.id) nameById.set(String(a.id), a.name || '')

  let client: any = null
  let accountIds: string[]
  let campaignFilter = ''
  if (clientQ) {
    const { rows } = await pool.query(
      `SELECT id, name, active, is_rollup, ad_account_ids, campaign_filter, leads_source, show_bookings, ghl_leads_tag,
              marketing_type, offer, coach_name, ltv_value, retainer_mode, retainer_flat_amount, data_source,
              sheet_id, sheet_tab, ghl_token_enc, ghl_location_id, use_sheet_for_leads
         FROM clients WHERE name ILIKE $1 OR id::text = $2 ORDER BY active DESC, name`, [`%${clientQ}%`, clientQ])
    // Exact name (or id) wins; if duplicates share a name, the active row wins.
    let exact = rows.filter((r: any) => r.name.toLowerCase() === clientQ.toLowerCase() || r.id === clientQ)
    if (exact.length > 1 && exact.filter((r: any) => r.active).length === 1) exact = exact.filter((r: any) => r.active)
    if (flag('list') || (rows.length !== 1 && exact.length !== 1)) {
      console.log(JSON.stringify({ matches: rows.map((r: any) => ({ id: r.id, name: r.name, active: r.active, is_rollup: r.is_rollup, ad_account_ids: r.ad_account_ids, campaign_filter: r.campaign_filter })) }, null, 2))
      if (!flag('list')) console.error(rows.length ? 'Ambiguous --client; re-run with the exact name.' : 'No client matched.')
      return
    }
    client = exact[0] || rows[0]
    accountIds = (client.ad_account_ids || []).map(String)
    campaignFilter = client.campaign_filter || ''
  } else {
    accountIds = [String(accountQ)]
  }

  const until = arg('until') || yesterdayNY()
  const since = arg('since') || addDays(until, -13)
  const len = daysBetween(since, until)
  const priorUntil = addDays(since, -1)
  const priorSince = addDays(priorUntil, -(len - 1))
  const inScope = (name: string, acct: string) => matchesCampaignFilter(name, campaignFilter, acct)

  // ---------- sync freshness (check first: stale sync explains most "bad numbers") ----------
  const sync = (await pool.query(
    `SELECT account_id, status, last_synced_at, last_success_until, adset_insights_until, ad_insights_until, last_error
       FROM agency_meta_sync_state WHERE account_id = ANY($1)`, [accountIds])).rows

  // ---------- campaign level, current + prior ----------
  const campRows = (await pool.query(
    `SELECT account_id, campaign_id, campaign_name, date::text AS date, spend, impressions, reach, link_clicks, results
       FROM meta_daily_insights
      WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3`, [accountIds, priorSince, until])).rows
    .filter((r: any) => inScope(r.campaign_name, r.account_id))

  const totCur = zero(), totPrev = zero()
  const daily = new Map<string, Agg>()
  const camps = new Map<string, { account_id: string; name: string; cur: Agg; prev: Agg }>()
  for (const r of campRows) {
    const isCur = r.date >= since
    const c = camps.get(r.campaign_id) || { account_id: r.account_id, name: r.campaign_name, cur: zero(), prev: zero() }
    camps.set(r.campaign_id, c)
    add(isCur ? c.cur : c.prev, r)
    add(isCur ? totCur : totPrev, r)
    if (isCur) { const d = daily.get(r.date) || zero(); add(d, r); daily.set(r.date, d) }
  }
  const campaignIds = [...camps.keys()]

  // ---------- entities (status, budgets, optimization goals) ----------
  const ents = (await pool.query(
    `SELECT level, entity_id, name, campaign_id, adset_id, effective_status, optimization_goal, offer_token,
            daily_budget, lifetime_budget, created_time::text AS created_time, start_time::text AS start_time, end_time::text AS end_time
       FROM meta_entities WHERE account_id = ANY($1) AND campaign_id = ANY($2)`, [accountIds, campaignIds])).rows
  const entById = new Map<string, any>(ents.map((e: any) => [`${e.level}:${e.entity_id}`, e]))

  // ---------- adset + ad level, current period (only ~90 days of history exist at these levels) ----------
  const subRows = (await pool.query(
    `SELECT level, entity_id, campaign_id, adset_id, adset_name, ad_name, date::text AS date, spend, impressions, reach, link_clicks, results
       FROM meta_daily_insights
      WHERE account_id = ANY($1) AND level IN ('adset','ad') AND campaign_id = ANY($2) AND date BETWEEN $3 AND $4`,
    [accountIds, campaignIds, since, until])).rows
  const adsets = new Map<string, { campaign_id: string; name: string; agg: Agg }>()
  const ads = new Map<string, { campaign_id: string; adset_id: string; name: string; agg: Agg }>()
  for (const r of subRows) {
    if (r.level === 'adset') {
      const a = adsets.get(r.entity_id) || { campaign_id: r.campaign_id, name: r.adset_name, agg: zero() }
      add(a.agg, r); adsets.set(r.entity_id, a)
    } else {
      const a = ads.get(r.entity_id) || { campaign_id: r.campaign_id, adset_id: r.adset_id, name: r.ad_name, agg: zero() }
      add(a.agg, r); ads.set(r.entity_id, a)
    }
  }

  // ---------- creative fatigue: 4 weekly buckets ending `until` ----------
  const fatigueSince = addDays(until, -27)
  const assetRows = (await pool.query(
    `SELECT b.asset_key, a.type, a.theme, a.ugc_status, LEFT(COALESCE(a.title, a.body, ''), 80) AS label,
            b.date::text AS date, b.spend, b.impressions, b.reach, b.link_clicks, b.results, b.campaign_name, b.account_id
       FROM meta_asset_breakdown_daily b
       LEFT JOIN meta_creative_assets a ON a.account_id = b.account_id AND a.asset_key = b.asset_key
      WHERE b.account_id = ANY($1) AND b.date BETWEEN $2 AND $3`, [accountIds, fatigueSince, until])).rows
    .filter((r: any) => inScope(r.campaign_name || '', r.account_id))
  const assets = new Map<string, { type: string; theme: string | null; ugc: string | null; label: string; weeks: Agg[] }>()
  for (const r of assetRows) {
    const a = assets.get(r.asset_key) || { type: r.type, theme: r.theme, ugc: r.ugc_status, label: r.label, weeks: [zero(), zero(), zero(), zero()] }
    const w = Math.min(3, Math.floor((daysBetween(fatigueSince, r.date) - 1) / 7))
    add(a.weeks[w], r); assets.set(r.asset_key, a)
  }

  // ---------- agency benchmark: median campaign CPL (current period, >= $100 & >= 3 results) ----------
  const { bench, cpls, byOffer } = await loadBenchmark(since, until)

  // ---------- optional live Meta read (GET only): budgets/CBO, bid strategy, objective, learning stage ----------
  const live: Record<string, any> = {}
  const liveErrors: string[] = []
  if (flag('live')) {
    const conns = (await pool.query(`SELECT token_enc, account_ids FROM agency_bm_connections ORDER BY sort_order NULLS LAST`)).rows
    const tokenFor = (acct: string) => { const c = conns.find((c: any) => (c.account_ids || []).map(String).includes(acct)); return c ? decrypt(c.token_enc) : null }
    const activeCamps = [...camps.entries()].filter(([, c]) => c.cur.spend > 0)
    const activeAdsets = [...adsets.entries()].filter(([, a]) => a.agg.spend > 0)
    const byAcct = new Map<string, { camps: string[]; adsets: string[] }>()
    for (const [id, c] of activeCamps) { const b = byAcct.get(c.account_id) || { camps: [], adsets: [] }; b.camps.push(id); byAcct.set(c.account_id, b) }
    for (const [id, a] of activeAdsets) { const acct = camps.get(a.campaign_id)?.account_id; if (!acct) continue; const b = byAcct.get(acct) || { camps: [], adsets: [] }; b.adsets.push(id); byAcct.set(acct, b) }
    for (const [acct, b] of byAcct) {
      const token = tokenFor(acct)
      if (!token) { liveErrors.push(`no BM token covers account ${acct}`); continue }
      const get = async (ids: string[], fields: string) => {
        for (let attempt = 1; ; attempt++) {
          try {
            const j: any = await (await fetch(`https://graph.facebook.com/v22.0/?ids=${ids.join(',')}&fields=${fields}&access_token=${encodeURIComponent(token)}`)).json()
            if (j.error) throw new Error(`Meta ${j.error.code}/${j.error.error_subcode ?? '-'}: ${j.error.message}`)
            return j
          } catch (e) { if (attempt >= 2) throw e; await new Promise(r => setTimeout(r, 5000)) } // one retry for network blips
        }
      }
      // ?ids= batching: max 50 per call, avoids per-user rate limit (code 17). One bad ID fails the whole
      // batch, so on failure fall back to one-by-one and record only the IDs that really fail.
      const fetchIds = async (ids: string[], fields: string) => {
        for (let i = 0; i < ids.length; i += 50) {
          const batch = ids.slice(i, i + 50)
          try { Object.assign(live, await get(batch, fields)) } catch {
            for (const id of batch) {
              try { Object.assign(live, await get([id], fields)) } catch (e: any) { liveErrors.push(`${id}: ${e.message}`) }
            }
          }
        }
      }
      await fetchIds(b.camps, 'objective,bid_strategy,daily_budget,lifetime_budget,budget_remaining,special_ad_categories,effective_status')
      await fetchIds(b.adsets, 'effective_status,bid_strategy,bid_amount,daily_budget,lifetime_budget,optimization_goal,destination_type,learning_stage_info,promoted_object,created_time')
    }
  }
  const cents = (v: any) => (v != null && v !== '' ? Number(v) / 100 : null)
  const liveCampaign = (id: string) => live[id] && {
    status: live[id].effective_status ?? null, objective: live[id].objective, bid_strategy: live[id].bid_strategy ?? null,
    cbo_daily_budget: cents(live[id].daily_budget), cbo_lifetime_budget: cents(live[id].lifetime_budget),
    special_ad_categories: live[id].special_ad_categories,
  }
  const liveAdset = (id: string) => live[id] && {
    status: live[id].effective_status ?? null, bid_strategy: live[id].bid_strategy ?? null, bid_amount: cents(live[id].bid_amount),
    daily_budget: cents(live[id].daily_budget), lifetime_budget: cents(live[id].lifetime_budget),
    destination_type: live[id].destination_type ?? null, promoted_event: live[id].promoted_object?.custom_event_type ?? null,
    learning_stage: live[id].learning_stage_info?.status ?? null, created: live[id].created_time ?? null,
  }

  // ---------- reliability flags ----------
  // Per-level coverage: adset/ad sync often lags campaign level, which silently truncates their totals.
  const levelSpend = (lvl: 'adset' | 'ad') => [...(lvl === 'adset' ? adsets : ads).values()].reduce((s, a: any) => s + a.agg.spend, 0)
  const coverage = {
    adset_spend_pct_of_campaign: totCur.spend ? round((levelSpend('adset') / totCur.spend) * 100, 1) : null,
    ad_spend_pct_of_campaign: totCur.spend ? round((levelSpend('ad') / totCur.spend) * 100, 1) : null,
  }
  // Halves of the current window: shows whether the change is a trend or an artefact of a thin prior period.
  const half = Math.floor(len / 2)
  const firstHalf = zero(), secondHalf = zero()
  for (const [date, a] of daily) {
    const target = daysBetween(since, date) <= half ? firstHalf : secondHalf
    target.spend += a.spend; target.impressions += a.impressions; target.reachDaily += a.reachDaily; target.linkClicks += a.linkClicks; target.results += a.results
    for (const d of a.days) target.days.add(d)
  }

  // ---------- client lead source (sheet / GHL) with per-campaign attribution ----------
  let leadsBlock: any = null
  const clientLeadsByCampaign = new Map<string, { leads: number; prior: number }>()
  if (client && !flag('meta-only')) {
    const conns = (await pool.query(`SELECT token_enc, account_ids FROM agency_bm_connections ORDER BY sort_order NULLS LAST`)).rows
    leadsBlock = await clientLeads(client, accountIds, { since, until, priorSince, priorUntil }, conns, { perLead: true })
    const src = leadsBlock.resolved === 'sheet' ? leadsBlock.sheet : leadsBlock.resolved === 'ghl' ? leadsBlock.ghl : null
    for (const r of src?.by_campaign || []) if (r.meta_campaign_id) {
      const e = clientLeadsByCampaign.get(r.meta_campaign_id) || { leads: 0, prior: 0 }
      e.leads += r.leads; e.prior += r.prior_leads; clientLeadsByCampaign.set(r.meta_campaign_id, e)
    }
    if (leadsBlock.dashboard_leads) {
      const dl = leadsBlock.dashboard_leads
      leadsBlock.dashboard_cpl = dl.leads ? round(totCur.spend / dl.leads) : null
      leadsBlock.dashboard_prior_cpl = dl.prior_leads ? round(totPrev.spend / dl.prior_leads) : null
      leadsBlock.meta_vs_client_leads = { meta_results: totCur.results, client_leads: dl.leads, gap_pct: dl.leads ? round(((totCur.results - dl.leads) / dl.leads) * 100, 1) : null }
    }
  }

  // ---------- assemble ----------
  const cur = metrics(totCur), prev = metrics(totPrev)
  const out = {
    generated_at: new Date().toISOString(),
    note: 'Cached DB snapshot. results = Meta "Results" under the account\'s results rule. Money in account currency.',
    scope: {
      client: client && {
        name: client.name, is_rollup: client.is_rollup, active: client.active, campaign_filter: client.campaign_filter,
        leads_source: client.leads_source, show_bookings: client.show_bookings, ghl_leads_tag: client.ghl_leads_tag,
        has_ghl_token: !!client.ghl_token_enc, sheet_tab: client.sheet_tab,
        marketing_type: client.marketing_type, offer: client.offer, coach_name: client.coach_name,
        ltv_value: client.ltv_value, retainer_mode: client.retainer_mode, retainer_flat_amount: client.retainer_flat_amount,
        data_source: client.data_source,
      },
      accounts: accountIds.map(id => ({ id, name: nameById.get(id) || null })),
    },
    period: { since, until, days: len, prior_since: priorSince, prior_until: priorUntil },
    sync,
    live: flag('live') ? { fetched: Object.keys(live).length, errors: liveErrors } : 'not requested (pass --live for budgets/CBO, bid strategy, objective, learning stage)',
    client_leads: leadsBlock ?? (client ? 'skipped (--meta-only)' : 'n/a (--account mode has no client config)'),
    coverage: {
      ...coverage,
      warning: [coverage.adset_spend_pct_of_campaign, coverage.ad_spend_pct_of_campaign].some(p => p != null && p < 95)
        ? 'A lower level covers <95% of campaign spend (sync lag or pre-history). Don\'t compare its totals to campaign totals; judge that level on ratios only.'
        : null,
    },
    totals: {
      current: cur, prior: prev,
      prior_is_partial: prev.active_days < Math.ceil(len / 2),
      current_halves: { first: metrics(firstHalf), second: metrics(secondHalf) },
      change_pct: { spend: pctChange(cur.spend, prev.spend), results: pctChange(cur.results, prev.results), cpl: pctChange(cur.cpl, prev.cpl), ctr: pctChange(cur.ctr_pct, prev.ctr_pct), cpm: pctChange(cur.cpm, prev.cpm) },
    },
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, a]) => ({ date, spend: round(a.spend), results: a.results, cpl: a.results ? round(a.spend / a.results) : null })),
    campaigns: [...camps.entries()]
      .filter(([, c]) => c.cur.spend > 0 || c.prev.spend > 0)
      .sort(([, a], [, b]) => b.cur.spend - a.cur.spend)
      .map(([id, c]) => {
        const e = entById.get(`campaign:${id}`)
        const cm = metrics(c.cur)
        return {
          id, account_id: c.account_id, name: c.name, status: e?.effective_status ?? null, offer: e?.offer_token ?? null, created: e?.created_time ?? null,
          live: liveCampaign(id) || undefined,
          share_of_spend_pct: totCur.spend ? round((c.cur.spend / totCur.spend) * 100, 1) : null,
          current: cm, prior: metrics(c.prev), cpl_change_pct: pctChange(cm.cpl, metrics(c.prev).cpl),
          // Leads from the client's own source (sheet/GHL) attributed to this campaign; null when source is Meta.
          client_leads: leadsBlock?.dashboard_leads ? (clientLeadsByCampaign.get(id)?.leads ?? 0) : null,
          client_cpl: leadsBlock?.dashboard_leads && clientLeadsByCampaign.get(id)?.leads ? round(c.cur.spend / clientLeadsByCampaign.get(id)!.leads) : null,
          adsets: [...adsets.entries()].filter(([, a]) => a.campaign_id === id).sort(([, a], [, b]) => b.agg.spend - a.agg.spend).map(([aid, a]) => {
            const ae = entById.get(`adset:${aid}`)
            return {
              id: aid, name: a.name, status: ae?.effective_status ?? null, optimization_goal: ae?.optimization_goal ?? null,
              daily_budget: ae?.daily_budget != null ? Number(ae.daily_budget) / 100 : null,
              lifetime_budget: ae?.lifetime_budget != null ? Number(ae.lifetime_budget) / 100 : null,
              created: ae?.created_time ?? null, end_time: ae?.end_time ?? null, live: liveAdset(aid) || undefined, ...metrics(a.agg),
            }
          }),
        }
      }),
    ads: [...ads.entries()]
      .sort(([, a], [, b]) => b.agg.spend - a.agg.spend)
      .filter(([, a], i) => i < 40 || (a.agg.results === 0 && a.agg.spend >= 50))
      .map(([id, a]) => ({ id, name: a.name, campaign_id: a.campaign_id, adset_id: a.adset_id, status: entById.get(`ad:${id}`)?.effective_status ?? null, ...metrics(a.agg) })),
    ad_count_total: ads.size,
    creatives_weekly: {
      window: { since: fatigueSince, until, buckets: 'w1 (oldest) .. w4 (latest), 7 days each' },
      assets: [...assets.entries()]
        .map(([key, a]) => ({ key, ...a, total: a.weeks.reduce((s, w) => s + w.spend, 0) }))
        .filter(a => a.total >= 100)
        .sort((a, b) => b.total - a.total)
        .slice(0, 30)
        .map(a => ({ asset_key: a.key, type: a.type, theme: a.theme, ugc: a.ugc, label: a.label, spend_28d: round(a.total), weeks: a.weeks.map(metrics) })),
    },
    benchmark: {
      basis: 'All agency campaigns, same period, spend >= $100 and results >= 3',
      campaigns: bench.length,
      median_cpl: median(cpls),
      by_offer: [...byOffer.entries()].filter(([, l]) => l.length >= 3).map(([offer, l]) => ({ offer, campaigns: l.length, median_cpl: median(l) })).sort((a, b) => b.campaigns - a.campaigns).slice(0, 15),
    },
  }

  const json = JSON.stringify(out, null, 2)
  const outPath = arg('out')
  if (outPath) { writeFileSync(outPath, json); console.log(`wrote ${outPath} (${json.length} bytes, ${out.campaigns.length} campaigns, ${out.ads.length} ads)`) }
  else console.log(json)
}

main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => pool.end())
