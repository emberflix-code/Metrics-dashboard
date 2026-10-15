/**
 * Read-only: Alloy BM2 campaigns with spend in a range that no ACTIVE non-rollup Alloy client's campaign_filter matches,
 * plus which INACTIVE Alloy clients would match them.
 * Run (from portal/): railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_alloy_unmatched_campaigns.ts 2026-09-01 2026-09-30
 */
import { Pool } from 'pg'

const [SINCE, UNTIL] = [process.argv[2] || '2026-09-01', process.argv[3] || '2026-09-30']
const ACCTS = ['1007481743408819', '3023829647843614']
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
const matches = (name: string, filter: string, acct: string) => {
  if (!filter) return true
  const segs = filter.split('|').map(s => s.trim()).filter(Boolean)
  if (segs.some(s => s === `unfiltered:${acct}`)) return true
  const needles = segs.filter(s => !s.startsWith('unfiltered:'))
  return needles.length === 0 || needles.some(n => name.toLowerCase().includes(n.toLowerCase()))
}

async function main() {
  const camps = (await pool.query(
    `SELECT account_id, campaign_name, SUM(spend)::float AS spend, SUM(results)::int AS results
     FROM meta_daily_insights WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3
     GROUP BY 1, 2 HAVING SUM(spend) > 0 ORDER BY 3 DESC`, [ACCTS, SINCE, UNTIL])).rows
  const clients = (await pool.query(`SELECT name, active, campaign_filter, sheet_tab FROM clients WHERE name ILIKE 'alloy%' AND name NOT ILIKE 'alloy ops%'`)).rows
  let total = 0
  for (const c of camps) {
    const hits = clients.filter(k => k.active && matches(c.campaign_name, k.campaign_filter || '', c.account_id))
    if (hits.length === 1) continue
    const inactive = clients.filter(k => !k.active && matches(c.campaign_name, k.campaign_filter || '', c.account_id)).map(k => k.name)
    if (hits.length === 0) total += c.spend
    console.log(`${hits.length === 0 ? 'UNMATCHED' : 'MULTI x' + hits.length} $${c.spend.toFixed(2)} results ${c.results} | ${c.campaign_name} | active hits: ${hits.map(h => h.name).join('; ')} | inactive hits: ${inactive.join('; ')}`)
  }
  console.log(`unmatched spend total $${total.toFixed(2)}`)
  console.log('inactive alloy clients:', clients.filter(k => !k.active).map(k => `${k.name} [${k.campaign_filter}]`).join(' || '))
  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
