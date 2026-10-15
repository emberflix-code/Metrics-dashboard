/**
 * Read-only: Top headlines + top ad copy for the GMN Marketing Report (Alloy), for one month.
 *  - Metrics come from Meta's title_asset / body_asset breakdowns (meta_copy_breakdown_daily, synced by syncCopyBreakdowns),
 *    i.e. the per-text numbers Ads Manager shows for Dynamic Creative ads. Check the coverage line it prints: the copy
 *    breakdown spend should be ~= the month's spend; if not, run the copy sync for the account first.
 *  - Headlines are grouped by exact text. Ad copy is grouped by TEMPLATE: the city of the row's location (and any
 *    "<City> Area …" / "Hey <City>!" city) is swapped for "{City}" and the coach's name ("My name is <Name>.") for
 *    "{Coach}", so the same copy run at many locations is one row.
 *  - Ranked by CPL (Meta leads) among items with ≥ MIN_SPEND spend and ≥1 lead (same $300 rule as the creatives); top 10.
 *  - Each item lists the locations that ran it (campaign name → Alloy location by campaign filter, most specific wins).
 * Output: { topHeadlines, topAdCopy, note } consumed by _build_alloy_month_xlsx.py (11th arg) into the report payload.
 * Run (from portal/): railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_alloy_month_top_copy.ts 2026-09 <outFile> [--force]
 *  Refuses to write when the copy breakdown covers < 98% of the month's spend (the daily sync hasn't caught up yet).
 */
import { Pool } from 'pg'
import { writeFileSync } from 'fs'

const [MONTH, OUT] = [process.argv[2] || '2026-09', process.argv[3] || 'alloy_top_copy.json']
const [y, m] = MONTH.split('-').map(Number)
const SINCE = `${MONTH}-01`, UNTIL = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
const ACCOUNTS = ['1007481743408819', '3023829647843614']
const MIN_SPEND = 300, TOP_N = 10, MIN_COVERAGE = 0.98
const FORCE = process.argv.includes('--force')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

const matches = (name: string, filter: string) => {
  const needles = (filter || '').split('|').map(s => s.trim()).filter(s => s && !s.startsWith('unfiltered:'))
  return needles.length > 0 && needles.some(n => name.toLowerCase().includes(n.toLowerCase()))
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Meta's automatic translations of the copy (Portuguese, Spanish, Tagalog, Arabic, …) show up as their own headlines and
// bodies; the report lists English copy only (user, 2026-10-16). Non-English = any accented / non-Latin letter, or a
// common non-English word. Every excluded text is printed with its spend so the cut can be checked.
const FOREIGN_WORDS = new Set(('de del la las el los con para por una que neste nesta este esta otoño outono autunno automne herbst '
  + 'emagrecimento emagreça adelgaza adega dimagrimento dimagrisci perda peso amincissement perdez poids abnehmen payat na ngayong '
  + 'taglagas katawan alerta oferta increíble giảm cân mùa thu naghahanap kami gusto ang mga ng nous pour avec und der das').split(' '))
const isEnglish = (text: string) => {
  const letters = text.replace(/\{(City|Coach)\}/g, '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
  if (/[^\x00-\x7F\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0\u2022\u2705\u23E9\u23EA\u2B50]/.test(letters)) return false
  return !letters.toLowerCase().split(/[^a-z']+/).some(w => FOREIGN_WORDS.has(w))
}

type Agg = { spend: number; impressions: number; linkClicks: number; leads: number }
const add = (a: Agg, b: Agg) => { a.spend += b.spend; a.impressions += b.impressions; a.linkClicks += b.linkClicks; a.leads += b.leads }
const zero = (): Agg => ({ spend: 0, impressions: 0, linkClicks: 0, leads: 0 })
const finish = (a: Agg) => ({ spend: Math.round(a.spend * 100) / 100, impressions: a.impressions, linkClicks: a.linkClicks,
  ctr: a.impressions ? Math.round(a.linkClicks / a.impressions * 10000) / 100 : null, leads: a.leads,
  cpl: a.leads ? Math.round(a.spend / a.leads * 100) / 100 : null })

async function main() {
  const locations = (await pool.query(`SELECT DISTINCT ON (name) name, campaign_filter FROM clients
    WHERE name ILIKE 'alloy%' AND name NOT ILIKE 'alloy ops%' AND name NOT ILIKE '%test%' AND COALESCE(campaign_filter,'') <> ''
    ORDER BY name, active DESC`)).rows
  const locOf = new Map<string, string>()
  const locationFor = (campaign: string) => {
    if (!locOf.has(campaign)) {
      const hit = locations.filter(l => matches(campaign, l.campaign_filter)).sort((a, b) => b.campaign_filter.length - a.campaign_filter.length)[0]
      locOf.set(campaign, hit ? hit.name : '(unmatched campaign)')
    }
    return locOf.get(campaign)!
  }
  // "Alloy Personal Training South Naperville, IL" -> ["South Naperville", "Naperville"]
  const citiesOf = (loc: string) => {
    const c = loc.replace(/^alloy\s+(personal\s+training\s+)?/i, '').replace(/,.*$/, '').trim()
    const out = [c]
    const words = c.split(/\s+/)
    if (words.length > 1 && /^(north|south|east|west|downtown|central|old|new)$/i.test(words[0]) === true) out.push(words.slice(1).join(' '))
    return out.filter(Boolean)
  }
  const template = (text: string, loc: string) => {
    const cities = new Set(loc.startsWith('(') ? [] : citiesOf(loc))
    const a = text.match(/^[^A-Za-z]*([A-Z][A-Za-z.' -]+?) Area\b/)
    const b = text.match(/\bHey ([A-Z][A-Za-z.' -]+?)!/)
    if (a) cities.add(a[1].trim())
    if (b) cities.add(b[1].trim())
    let t = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    for (const c of Array.from(cities).sort((x, y) => y.length - x.length)) t = t.replace(new RegExp(`\\b${escapeRe(c)}\\b`, 'g'), '{City}')
    // the coach's sign-off differs per location too ("My name is Tina." / "I'm Tina,")
    t = t.replace(/\b(My name is|I'm|I am) ([A-Z][a-zA-Z'-]+(?: (?:&|and) [A-Z][a-zA-Z'-]+)?)(?=[.,!])/g, '$1 {Coach}')
    return t
  }

  const monthSpend = (await pool.query(`SELECT COALESCE(SUM(spend),0)::float s FROM meta_daily_insights
    WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3`, [ACCOUNTS, SINCE, UNTIL])).rows[0].s

  const out: Record<string, any> = {}
  const coverage: string[] = []
  let lowCoverage = false
  const excluded = new Map<string, number>()
  for (const [kind, key] of [['title', 'topHeadlines'], ['body', 'topAdCopy']] as const) {
    const rows = (await pool.query(
      `SELECT t.text, b.campaign_name, SUM(b.spend)::float spend, SUM(b.impressions)::bigint impressions,
              SUM(b.link_clicks)::bigint link_clicks, SUM(b.results)::int results
       FROM meta_copy_breakdown_daily b JOIN meta_copy_texts t ON t.kind = b.kind AND t.text_hash = b.text_hash
       WHERE b.account_id = ANY($1) AND b.kind = $2 AND b.date BETWEEN $3 AND $4
       GROUP BY t.text, b.campaign_name`, [ACCOUNTS, kind, SINCE, UNTIL])).rows
    const groups = new Map<string, { total: Agg; byLoc: Map<string, Agg>; texts: Set<string> }>()
    let covered = 0
    for (const r of rows) {
      const loc = locationFor(r.campaign_name || '')
      const k = kind === 'title' ? r.text.replace(/\s+/g, ' ').trim() : template(r.text, loc)
      covered += r.spend
      if (!isEnglish(k)) { excluded.set(`${kind}|${k.slice(0, 80)}`, (excluded.get(`${kind}|${k.slice(0, 80)}`) || 0) + r.spend); continue }
      let g = groups.get(k)
      if (!g) { g = { total: zero(), byLoc: new Map(), texts: new Set() }; groups.set(k, g) }
      const v = { spend: r.spend, impressions: Number(r.impressions), linkClicks: Number(r.link_clicks), leads: r.results }
      add(g.total, v)
      if (!g.byLoc.has(loc)) g.byLoc.set(loc, zero())
      add(g.byLoc.get(loc)!, v)
      g.texts.add(r.text)
    }
    if (covered < monthSpend * MIN_COVERAGE) lowCoverage = true
    coverage.push(`${kind}: ${groups.size} groups, breakdown spend $${covered.toFixed(2)} of $${monthSpend.toFixed(2)} (${(covered / monthSpend * 100).toFixed(1)}%)`)
    out[key] = Array.from(groups.entries())
      .filter(([, g]) => g.total.spend >= MIN_SPEND && g.total.leads > 0)
      .sort((a, b) => a[1].total.spend / a[1].total.leads - b[1].total.spend / b[1].total.leads)
      .slice(0, TOP_N)
      .map(([text, g], i) => ({
        rank: i + 1, text, variants: g.texts.size, ...finish(g.total),
        locations: Array.from(g.byLoc.entries()).map(([location, v]) => ({ location, ...finish(v) })).sort((a, b) => b.spend - a.spend),
      }))
  }
  out.note = `Headlines and ad copy ranked by CPL (Meta leads, Ads Manager per-text breakdown) among those with at least $${MIN_SPEND} spend `
    + `and 1+ lead, English copy only (Meta's automatic translations are left out). Ad copy is grouped by template: the same copy run at several locations, with only the city and coach name changed, counts as one.`
  coverage.forEach(c => console.log(c))
  const ex = Array.from(excluded.entries()).sort((a, b) => b[1] - a[1])
  console.log(`excluded as non-English: ${ex.length} texts, $${ex.reduce((s, [, v]) => s + v, 0).toFixed(2)}`)
  for (const [t, v] of ex.slice(0, 40)) console.log(`  $${v.toFixed(2)}  ${t.replace(/\n/g, ' / ')}`)
  if (lowCoverage && !FORCE) {
    console.error(`Copy breakdown covers under ${MIN_COVERAGE * 100}% of the month's spend, so the month isn't fully synced yet; nothing written.
`
      + `Catch up first (from portal/, repeat until covered): railway run --service Metrics-dashboard npx --yes tsx -e "require('./src/lib/metaSync').syncAccountCopyOnly('<account id>').then(r => { console.log(r); process.exit(0) })"
`
      + `or pass --force to write anyway.`)
    process.exit(2)
  }
  console.log(`headlines: ${out.topHeadlines.length}, ad copy: ${out.topAdCopy.length}`)
  writeFileSync(OUT, JSON.stringify(out, null, 2))
  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
