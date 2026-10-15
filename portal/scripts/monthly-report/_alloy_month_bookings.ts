/**
 * Read-only: per Alloy location, an audit of every appointment SCHEDULED in a month on the location's booking calendar
 * (clients.booking_calendar_link, copied daily from the Nurture Team sheet), and the bookings count derived from it:
 *   Bookings = distinct people tagged as ad leads (Leads Tag, or an offer version of it like "new ad lead - gmn - 2 weeks free")
 *              with at least one appointment that is not cancelled/invalid.
 * Events for contacts without the lead tag (internal meetings, staff blocks, vendors, untagged prospects) are listed but not
 * counted. Names are reduced to first name + last initial. Rule chosen by the user 2026-10-16 (option A).
 * Run (from portal/): railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_alloy_month_bookings.ts 2026-09 <outFile>
 * Optional env ONLY="exact name;exact name" pulls just those locations.
 */
import { Pool } from 'pg'
import { writeFileSync } from 'fs'
import { decrypt } from '../../src/lib/crypto'

const [MONTH, OUT] = [process.argv[2] || '2026-09', process.argv[3] || 'alloy_bookings.json']
const GHL = 'https://services.leadconnectorhq.com'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Locations whose Nurture-sheet calendar is not where bookings land (checked 2026-10-15):
// Colorado Springs' sheet calendar had 0 Sep events; its bookings are on the older "Intro Call" calendar.
const CALENDAR_OVERRIDES: Record<string, string> = {
  'Alloy Personal Training Colorado Springs, CO': 'ewKORSQ9FjnhQBEijqYy',
}
const NOT_COUNTED_STATUS = new Set(['cancelled', 'invalid'])

async function ghl(path: string, token: string, version = '2021-04-15'): Promise<any> {
  for (let a = 1; ; a++) {
    let res: Response
    try {
      res = await fetch(`${GHL}${path}`, { headers: { Authorization: `Bearer ${token}`, Version: version, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    } catch (e: any) { if (a <= 4) { await sleep(3000 * a); continue } return { error: `network: ${e.cause?.code || e.message}` } }
    if (res.status === 429 && a <= 5) { await sleep(4000 * a); continue }
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return { error: `${res.status} ${JSON.stringify(j).slice(0, 160)}` }
    return j
  }
}

function calendarRef(link: string | null): { id?: string; slug?: string } {
  if (!link) return {}
  const id = link.match(/widget\/booking\/([A-Za-z0-9]+)/)
  if (id) return { id: id[1] }
  const slug = link.match(/widget\/bookings\/([^?#/]+)/)
  return slug ? { slug: decodeURIComponent(slug[1]) } : {}
}
const short = (k: any) => k ? `${(k.firstName || '').trim()} ${((k.lastName || '').trim()[0] || '')}${(k.lastName || '').trim() ? '.' : ''}`.trim() || '(no name)' : '(no contact)'
const RANK: Record<string, number> = { showed: 4, confirmed: 3, new: 3, booked: 3, noshow: 1 }

async function main() {
  const clients = (await pool.query(`SELECT id, name, active, ghl_token_enc, ghl_location_id, ghl_leads_tag, booking_calendar_name, booking_calendar_link
    FROM clients WHERE name ILIKE 'alloy%' AND name NOT ILIKE 'alloy ops%' AND name NOT ILIKE '%test%' AND active = true ORDER BY name`)).rows
    .filter(c => !process.env.ONLY || process.env.ONLY.split(';').map((s: string) => s.trim()).includes(c.name))
  const out: any[] = []
  for (const c of clients) {
    const row: any = { name: c.name, calendar_name: c.booking_calendar_name || null }
    out.push(row)
    const ref = CALENDAR_OVERRIDES[c.name] ? { id: CALENDAR_OVERRIDES[c.name] } : calendarRef(c.booking_calendar_link)
    if (CALENDAR_OVERRIDES[c.name]) row.calendar_override = true
    if (!c.ghl_token_enc || !c.ghl_location_id) { row.status = 'no GHL connection'; continue }
    if (!ref.id && !ref.slug) { row.status = 'no booking calendar on dashboard'; continue }
    const token = decrypt(c.ghl_token_enc)
    const tags = (c.ghl_leads_tag || '').split('|').map((t: string) => t.trim().toLowerCase()).filter(Boolean)
    const isLead = (k: any) => !!k && (tags.length
      ? (k.tags || []).some((t: string) => { const l = t.toLowerCase(); return tags.some((b: string) => l === b || l.startsWith(b + ' ')) })
      : !!k.attributionSource?.campaign)
    const loc = await ghl(`/locations/${c.ghl_location_id}`, token, '2021-07-28')
    const tz = loc?.location?.timezone || 'America/New_York'
    row.tz = tz
    const cals = await ghl(`/calendars/?locationId=${c.ghl_location_id}`, token)
    if (cals.error) { row.status = `calendar list failed: ${cals.error}`; continue }
    const cal = (cals.calendars || []).find((k: any) => (ref.id && k.id === ref.id) || (ref.slug && (k.widgetSlug === ref.slug || k.slug === ref.slug)))
    if (!cal) { row.status = `calendar ${ref.id || ref.slug} not found in this GHL location`; continue }
    row.ghl_calendar = cal.name
    const day = (iso: string | number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
    const [y, m] = MONTH.split('-').map(Number)
    const ev = await ghl(`/calendars/events?locationId=${c.ghl_location_id}&calendarId=${cal.id}&startTime=${Date.UTC(y, m - 1, 1) - 2 * 86400000}&endTime=${Date.UTC(y, m, 1) + 2 * 86400000}`, token)
    if (ev.error) { row.status = `events failed: ${ev.error}`; continue }
    const events = (ev.events || []).filter((e: any) => day(e.startTime).slice(0, 7) === MONTH && !e.deleted)
      .sort((a: any, b: any) => Date.parse(a.startTime) - Date.parse(b.startTime))
    const contacts = new Map<string, any>()
    for (const id of Array.from(new Set(events.map((e: any) => e.contactId).filter(Boolean))) as string[]) {
      const j = await ghl(`/contacts/${id}`, token, '2021-07-28')
      contacts.set(id, j.contact || null)
    }
    const status = (e: any) => String(e.appointmentStatus || e.appoinmentStatus || '').toLowerCase() || 'none'
    const audit: any[] = []
    const people = new Map<string, { name: string; best: string; n: number }>()
    for (const e of events) {
      const k = e.contactId ? contacts.get(e.contactId) : null
      const st = status(e)
      const lead = isLead(k)
      let counted = false, reason = ''
      if (NOT_COUNTED_STATUS.has(st)) reason = st === 'cancelled' ? 'cancelled' : 'invalid appointment'
      else if (!lead) reason = k ? 'contact not tagged as an ad lead (internal / staff / untagged)' : 'no contact on the event'
      else {
        const p = people.get(e.contactId)
        if (p) { reason = `repeat booking by ${p.name} (person counted once)`; p.n++; if ((RANK[st] || 2) > (RANK[p.best] || 2)) p.best = st }
        else { counted = true; reason = 'counted'; people.set(e.contactId, { name: short(k), best: st, n: 1 }) }
      }
      audit.push({ date: day(e.startTime), who: short(k), contact_id: e.contactId || '', title: lead ? '' : String(e.title || '').slice(0, 60),
        status: st, minutes: Math.round((Date.parse(e.endTime) - Date.parse(e.startTime)) / 60000), lead_tagged: lead, counted, reason })
    }
    // a repeat booking can upgrade the person's status (e.g. no-show, then showed)
    for (const a of audit) if (a.counted) a.status_final = people.get(a.contact_id)!.best
    const ppl = Array.from(people.values())
    const nonLead = audit.filter(a => a.reason.startsWith('contact not tagged') || a.reason === 'no contact on the event')
    const nonLeadGroups: Record<string, number> = {}
    for (const a of nonLead) { const key = a.title || a.who; nonLeadGroups[key] = (nonLeadGroups[key] || 0) + 1 }
    Object.assign(row, {
      status: 'ok',
      events_total: events.length,
      cancelled: audit.filter(a => a.status === 'cancelled').length,
      invalid: audit.filter(a => a.status === 'invalid').length,
      non_lead_events: nonLead.length,
      non_lead_groups: nonLeadGroups,
      repeats: ppl.filter(p => p.n > 1).map(p => ({ name: p.name, appointments: p.n })),
      booked_ex_cancelled: ppl.length,
      showed: ppl.filter(p => p.best === 'showed').length,
      confirmed: ppl.filter(p => (RANK[p.best] || 2) === 3 || !(p.best in RANK)).length,
      noshow: ppl.filter(p => p.best === 'noshow').length,
      audit,
    })
    await sleep(200)
  }
  writeFileSync(OUT, JSON.stringify({ month: MONTH, rule: 'distinct lead-tagged people with a non-cancelled appointment', generatedAt: new Date().toISOString(), rows: out }, null, 1))
  for (const r of out) console.log(`${r.name.padEnd(52).slice(0, 52)} | ${r.status === 'ok'
    ? `${String(r.booked_ex_cancelled).padStart(3)} people (S${r.showed} C${r.confirmed} NS${r.noshow}) | ${r.events_total} events: -${r.cancelled} cancelled -${r.invalid} invalid -${r.non_lead_events} not lead-tagged -${r.repeats.reduce((s: number, p: any) => s + p.appointments - 1, 0)} repeats | ${r.ghl_calendar}`
    : r.status}`)
  await pool.end()
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1) })
