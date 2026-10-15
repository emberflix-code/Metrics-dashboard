/**
 * Read-only: per Alloy location × offer, the month's cached Meta metrics (same source as the dashboard / monthly report)
 * and sheet leads, for the GMN Marketing Report's "Marketing Offer Breakdown".
 * Offer = the campaign-name segment after the location: "GMN - Alloy Training Royal Oak, MI - 30-Day Transformation - 9/9 - …".
 * Run (from portal/): railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_alloy_month_offers.ts 2026-09 <outFile>
 */
import { Pool } from 'pg'
import { writeFileSync } from 'fs'
import { fetchSheetRows } from '../../src/lib/sheets'

const [MONTH, OUT] = [process.argv[2] || '2026-09', process.argv[3] || 'alloy_offers.json']
const [y, m] = MONTH.split('-').map(Number)
const SINCE = `${MONTH}-01`, UNTIL = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })
const ACCOUNTS = ['1007481743408819', '3023829647843614']

const matches = (name: string, filter: string) => {
  const needles = (filter || '').split('|').map(s => s.trim()).filter(s => s && !s.startsWith('unfiltered:'))
  return needles.length > 0 && needles.some(n => name.toLowerCase().includes(n.toLowerCase()))
}
/** "GMN - Alloy Training X, ST - 30-Day Transformation - 9/9 - …" -> "30-Day Transformation" */
export function offerOf(campaign: string): string {
  // tolerate a missing space on one side of the separator ("…Broadway Park, CO- Free 14-Day …"); "30-Day" has none on either
  const parts = (campaign || '').split(/\s*-\s+|\s+-\s*/).map(s => s.trim())
  const i = parts.findIndex(p => /alloy\s+(personal\s+)?training/i.test(p))
  let offer = i >= 0 ? parts[i + 1] : ''
  if (!offer || /^\d{1,2}\/\d{1,2}/.test(offer)) return 'Other'
  offer = offer.replace(/\s+/g, ' ').replace(/^30\s*-?\s*day/i, '30-Day')
  return offer.split(' ').map(w => (w.length > 2 && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
}

async function main() {
  // One row per location name: an inactive duplicate (the second "Loveland" row) shares the active row's name and sheet
  // tab and would double its leads — keep the active one.
  const clients = (await pool.query(`SELECT DISTINCT ON (name) name, campaign_filter, sheet_id, sheet_tab, active, is_rollup FROM clients
    WHERE name ILIKE 'alloy%' AND name NOT ILIKE 'alloy ops%' AND name NOT ILIKE '%test%' AND COALESCE(campaign_filter,'') <> ''
    ORDER BY name, active DESC`)).rows
  const camps = (await pool.query(
    `SELECT campaign_name, SUM(spend)::float AS spend, SUM(impressions)::bigint AS impressions, SUM(reach)::bigint AS reach,
            SUM(link_clicks)::bigint AS link_clicks, SUM(results)::int AS results
     FROM meta_daily_insights WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3
     GROUP BY campaign_name`, [ACCOUNTS, SINCE, UNTIL])).rows
  const out: Record<string, Record<string, any>> = {}
  const unmatched: any[] = []
  const bucket = (loc: string, offer: string) => ((out[loc] ||= {})[offer] ||= { spend: 0, impressions: 0, reach: 0, link_clicks: 0, meta_results: 0, sheet_leads: 0, campaigns: [] as string[] })
  for (const c of camps) {
    const hits = clients.filter(k => matches(c.campaign_name, k.campaign_filter))
    // the most specific filter wins if two clients match (e.g. an inactive duplicate) — same rule as the report rows
    const loc = hits.sort((a, b) => b.campaign_filter.length - a.campaign_filter.length)[0]
    if (!loc) { if (c.spend > 0) unmatched.push({ campaign: c.campaign_name, spend: c.spend }); continue }
    const b = bucket(loc.name, offerOf(c.campaign_name))
    b.spend += c.spend; b.impressions += Number(c.impressions); b.reach += Number(c.reach); b.link_clicks += Number(c.link_clicks); b.meta_results += c.results
    b.campaigns.push(c.campaign_name)
  }
  for (const k of clients) {
    if (!k.sheet_id || !k.sheet_tab) continue
    try {
      const res = await fetchSheetRows(k.sheet_id, k.sheet_tab)
      for (const r of res.rows.filter((r: any) => r.day >= SINCE && r.day <= UNTIL && r.leads)) bucket(k.name, offerOf(r.campaign)).sheet_leads += r.leads
    } catch { /* missing tab: no sheet leads for this location (same as the report) */ }
  }
  writeFileSync(OUT, JSON.stringify({ month: MONTH, since: SINCE, until: UNTIL, locations: out, unmatched }, null, 1))
  const offers: Record<string, { spend: number; leads: number; locs: number }> = {}
  for (const loc of Object.values(out)) for (const [o, v] of Object.entries(loc)) {
    const t = (offers[o] ||= { spend: 0, leads: 0, locs: 0 }); t.spend += v.spend; t.leads += v.sheet_leads; t.locs++
  }
  for (const [o, t] of Object.entries(offers).sort((a, b) => b[1].spend - a[1].spend)) console.log(`${o.padEnd(40)} $${t.spend.toFixed(2).padStart(10)} leads ${String(t.leads).padStart(5)} locations ${t.locs}`)
  console.log('unmatched campaigns with spend:', unmatched.length, unmatched.slice(0, 5))
  console.log('"Other" campaigns:', Object.entries(out).flatMap(([l, o]) => (o.Other?.campaigns || []).map((c: string) => `${l}: ${c}`)))
  const tot = Object.values(out).flatMap(o => Object.values(o)).reduce((s: any, v: any) => ({ spend: s.spend + v.spend, leads: s.leads + v.sheet_leads }), { spend: 0, leads: 0 })
  console.log('TOTAL spend', tot.spend.toFixed(2), 'sheet leads', tot.leads)
  await pool.end()
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1) })
