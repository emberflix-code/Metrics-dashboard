// Publish / unpublish / show a GMN Marketing Report month for a client (client_monthly_reports, migration 036).
// Writes ONE row per (client, month) — nothing else. Republishing the same month replaces its payload.
//   publish:    npx tsx scripts/monthly-report/_publish_monthly_report.ts --client <uuid> --month YYYY-MM --file <out>.payload.json
//   draft:      ... --client <uuid> --month YYYY-MM --file <payload.json> --draft   (stored, not shown on the page)
//   unpublish:  ... --client <uuid> --month YYYY-MM --unpublish                      (hidden from the page, row kept)
//   show:       ... --client <uuid> --month YYYY-MM --show
// Payload: built by _build_alloy_month_xlsx.py (8th arg offers JSON, 9th arg top-creatives JSON) — see GmnReportPayload
// in src/lib/gmnReport.ts. Run against prod with `railway run npx tsx scripts/monthly-report/_publish_monthly_report.ts ...`.
import { Pool } from 'pg'
import { readFileSync } from 'fs'
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const flag = (k: string) => process.argv.includes(`--${k}`)
const url = process.env.DATABASE_URL || ''
const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 2 })
;(async () => {
  const client = arg('client'), month = arg('month')
  if (!client || !month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('need --client <uuid> and --month YYYY-MM')
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_gmn_report BOOLEAN NOT NULL DEFAULT false`)
  await pool.query(`CREATE TABLE IF NOT EXISTS client_monthly_reports (
    id SERIAL PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE, month DATE NOT NULL,
    payload JSONB NOT NULL, published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (client_id, month))`)
  const [c] = (await pool.query(`SELECT name, show_gmn_report FROM clients WHERE id = $1`, [client])).rows
  if (!c) throw new Error(`client ${client} not found`)
  const day = `${month}-01`
  let row: any
  if (flag('unpublish')) {
    row = (await pool.query(`UPDATE client_monthly_reports SET published_at = NULL, updated_at = NOW() WHERE client_id = $1 AND month = $2 RETURNING *`, [client, day])).rows[0]
  } else if (flag('show')) {
    row = (await pool.query(`SELECT * FROM client_monthly_reports WHERE client_id = $1 AND month = $2`, [client, day])).rows[0]
  } else {
    const file = arg('file')
    if (!file) throw new Error('need --file <payload.json> to publish')
    const payload = JSON.parse(readFileSync(file, 'utf8'))
    if (payload.version !== 1 || payload.month !== month) throw new Error(`payload month ${payload.month} / version ${payload.version} does not match --month ${month}`)
    for (const k of ['overview', 'locations', 'locationsTotal', 'offers', 'offersTotal', 'topCreatives']) if (!(k in payload)) throw new Error(`payload missing ${k}`)
    row = (await pool.query(
      `INSERT INTO client_monthly_reports (client_id, month, payload, published_at) VALUES ($1, $2, $3, ${flag('draft') ? 'NULL' : 'NOW()'})
       ON CONFLICT (client_id, month) DO UPDATE SET payload = EXCLUDED.payload, published_at = EXCLUDED.published_at, updated_at = NOW()
       RETURNING *`, [client, day, JSON.stringify(payload)])).rows[0]
  }
  if (!row) { console.log(`no report for ${c.name} ${month}`); await pool.end(); return }
  const p = row.payload
  console.log(JSON.stringify({
    client: c.name, show_gmn_report: c.show_gmn_report, month, published_at: row.published_at, updated_at: row.updated_at,
    locations: p.locations?.length, offers: p.offers?.length, topCreatives: p.topCreatives?.length,
    overview: p.overview,
  }, null, 1))
  if (!c.show_gmn_report) console.log('note: the GMN Marketing Report toggle is OFF for this client — turn it on in admin to show the button')
  await pool.end()
})().catch(async e => { console.error(e.message || e); await pool.end(); process.exit(1) })
