/**
 * Read-only audit of every client's GoHighLevel connection: token opens its stored location, GHL's location name matches
 * the dashboard name, no token/location shared between dashboards, and the token can read contacts, calendars and forms.
 * Run (from portal/): railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_ghl_token_audit.ts <outFile>
 */
import { Pool } from 'pg'
import { createHash } from 'crypto'
import { writeFileSync } from 'fs'
import { decrypt } from '../../src/lib/crypto'

const OUT = process.argv[2] || 'ghl_token_audit.json'
const GHL = 'https://services.leadconnectorhq.com'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const NOISE = new Set(['alloy', 'personal', 'training', 'pt', 'the', 'and', 'of', 'anytime', 'fitness', 'af'])
const STATES = new Set('al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy bc ab on qc'.split(' '))
const words = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w && !NOISE.has(w) && !STATES.has(w))

async function call(path: string, token: string, method = 'GET', body?: any, version = '2021-07-28'): Promise<{ status: number; json: any }> {
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(`${GHL}${path}`, { method, signal: AbortSignal.timeout(30_000), body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${token}`, Version: version, Accept: 'application/json', 'Content-Type': 'application/json' } })
      if (res.status === 429 && a <= 4) { await sleep(3000 * a); continue }
      return { status: res.status, json: await res.json().catch(() => ({})) }
    } catch (e: any) { if (a <= 3) { await sleep(2000 * a); continue } return { status: 0, json: { message: e.cause?.code || e.message } } }
  }
}

async function main() {
  const clients = (await pool.query(`SELECT id, name, active, ghl_token_enc, ghl_location_id FROM clients
    WHERE ghl_token_enc IS NOT NULL AND ghl_token_enc <> '' ORDER BY active DESC, name`)).rows
  const tokHash = new Map<string, string[]>(), locIds = new Map<string, string[]>()
  const out: any[] = []
  for (const c of clients) {
    const r: any = { name: c.name, active: c.active, location_id: c.ghl_location_id || '', problems: [] as string[] }
    out.push(r)
    let token = ''
    try { token = decrypt(c.ghl_token_enc).trim() } catch { r.problems.push('stored token cannot be decrypted'); continue }
    r.token_kind = token.startsWith('pit-') ? 'Private Integration token' : token.split('.').length === 3 ? 'JWT / location API key' : 'unknown format'
    const h = createHash('sha256').update(token).digest('hex').slice(0, 12)
    tokHash.set(h, [...(tokHash.get(h) || []), c.name])
    if (c.ghl_location_id) locIds.set(c.ghl_location_id, [...(locIds.get(c.ghl_location_id) || []), c.name])
    if (!c.ghl_location_id) { r.problems.push('no location ID saved'); continue }

    const loc = await call(`/locations/${c.ghl_location_id}`, token)
    r.location_http = loc.status
    r.ghl_name = loc.json?.location?.name || ''
    if (loc.status !== 200) r.problems.push(`token cannot open this location ID (HTTP ${loc.status}: ${(loc.json?.message || '').toString().slice(0, 80)})`)
    else {
      const a = words(c.name), b = new Set(words(r.ghl_name))
      const overlap = a.filter(w => b.has(w)).length
      r.name_match = a.length ? overlap / a.length : 0
      if (r.name_match < 0.5) r.problems.push(`GHL location is "${r.ghl_name}" — does not look like this dashboard`)
    }
    const ct = await call('/contacts/search', token, 'POST', { locationId: c.ghl_location_id, pageLimit: 1 })
    r.contacts = ct.status === 200 ? `ok (${ct.json?.total ?? '?'} contacts)` : `HTTP ${ct.status}`
    if (ct.status !== 200) r.problems.push(`cannot read contacts (HTTP ${ct.status}: ${(ct.json?.message || '').toString().slice(0, 80)})`)
    const cal = await call(`/calendars/?locationId=${c.ghl_location_id}`, token, 'GET', undefined, '2021-04-15')
    r.calendars = cal.status === 200 ? `ok (${(cal.json?.calendars || []).length})` : `HTTP ${cal.status}`
    if (cal.status !== 200) r.problems.push(`cannot read calendars (HTTP ${cal.status}) — bookings will be blank`)
    const fm = await call(`/forms/submissions?locationId=${c.ghl_location_id}&limit=1&page=1`, token)
    r.forms = fm.status === 200 ? 'ok' : `HTTP ${fm.status}`
    if (fm.status !== 200) r.problems.push(`cannot read form submissions (HTTP ${fm.status}) — returning leads will be missed`)
    await sleep(200)
  }
  for (const [h, names] of tokHash) if (names.length > 1) for (const r of out.filter(x => names.includes(x.name))) r.problems.push(`same token as: ${names.filter(n => n !== r.name).join(', ')} (${h})`)
  for (const [id, names] of locIds) if (names.length > 1) for (const r of out.filter(x => names.includes(x.name))) r.problems.push(`same location ID as: ${names.filter(n => n !== r.name).join(', ')}`)
  writeFileSync(OUT, JSON.stringify(out, null, 1))
  for (const r of out) console.log(`${r.problems.length ? 'PROBLEM' : 'ok     '} | ${r.active ? 'active  ' : 'inactive'} | ${r.name.padEnd(52).slice(0, 52)} | GHL: ${(r.ghl_name || '-').slice(0, 48).padEnd(48)} | ${r.contacts || '-'} | cal ${r.calendars || '-'} | forms ${r.forms || '-'}${r.problems.length ? ' | ' + r.problems.join(' ; ') : ''}`)
  console.log(`\n${out.length} clients with a GHL token; ${out.filter(r => r.problems.length).length} with problems`)
  await pool.end()
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1) })
