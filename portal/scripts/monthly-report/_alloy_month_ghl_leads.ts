/**
 * Read-only: per active Alloy location, for one month —
 *  (1) GHL leads: contacts ADDED in the month (ad-account timezone, same as the dashboard) carrying the client's Leads Tag,
 *      minus test contacts and duplicates (same phone or email; the earliest is kept), each exclusion recorded;
 *      returning leads (added earlier, form resubmitted in the month) and unlisted "new ad lead…" tag variants are
 *      reported but NOT counted;
 *  (2) Meta status as of the last synced day: ACTIVE campaign matching the client's filter + spend in the last 7 days.
 * Names are reduced to first name + last initial. Run (from portal/):
 *   railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_alloy_month_ghl_leads.ts 2026-09 <outFile>
 */
import { Pool } from 'pg'
import { writeFileSync } from 'fs'
import { decrypt } from '../../src/lib/crypto'

const [MONTH, OUT] = [process.argv[2] || '2026-09', process.argv[3] || 'alloy_ghl_leads.json']
const GHL = 'https://services.leadconnectorhq.com'
const BM2 = '3023829647843614'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const TEST_RE = /\b(test|testing|tester|fake|asdf|qwerty|dummy)\b/i

async function ghl(path: string, token: string, init: { method?: string; body?: any } = {}): Promise<any> {
  for (let a = 1; ; a++) {
    let res: Response
    try {
      res = await fetch(`${GHL}${path}`, {
        method: init.method || 'GET', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' },
        body: init.body ? JSON.stringify(init.body) : undefined,
      })
    } catch (e: any) { if (a <= 4) { await sleep(3000 * a); continue } return { error: `network: ${e.cause?.code || e.message}` } }
    if (res.status === 429 && a <= 5) { await sleep(4000 * a); continue }
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return { error: `${res.status} ${(j.message || JSON.stringify(j)).toString().slice(0, 140)}` }
    return j
  }
}

// UTC instant of local midnight for a date in a timezone
function zonedMidnight(dateStr: string, tz: string): number {
  const guess = Date.parse(`${dateStr}T00:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess))
  const g = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const asLocal = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'))
  return guess - (asLocal - guess)
}
const short = (c: any) => `${(c.firstName || '').trim()} ${((c.lastName || '').trim()[0] || '')}${(c.lastName || '').trim() ? '.' : ''}`.trim() || '(no name)'
const phoneKey = (p: string) => { const d = (p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
const matchesFilter = (name: string, filter: string) => {
  const needles = (filter || '').split('|').map(s => s.trim()).filter(s => s && !s.startsWith('unfiltered:'))
  return needles.length === 0 || needles.some(n => name.toLowerCase().includes(n.toLowerCase()))
}

async function main() {
  const conns = (await pool.query(`SELECT token_enc, account_ids FROM agency_bm_connections`)).rows
  const metaToken = decrypt(conns.find(c => (c.account_ids || []).includes(BM2)).token_enc)
  const acct: any = await (await fetch(`https://graph.facebook.com/v22.0/act_${BM2}?fields=timezone_name&access_token=${encodeURIComponent(metaToken)}`)).json()
  const TZ = acct.timezone_name || 'America/New_York'
  const [y, m] = MONTH.split('-').map(Number)
  const monthStart = `${MONTH}-01`, nextStart = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const gte = new Date(zonedMidnight(monthStart, TZ)).toISOString(), lte = new Date(zonedMidnight(nextStart, TZ) - 1).toISOString()
  console.log(`account TZ ${TZ}; ${MONTH} = ${gte} .. ${lte}`)

  // Meta status: ACTIVE campaigns on BM2 (live) + last-7-day spend from the synced DB.
  const lastSynced = (await pool.query(`SELECT last_success_until FROM agency_meta_sync_state WHERE account_id = $1`, [BM2])).rows[0]?.last_success_until
  const until = new Date(lastSynced).toISOString().slice(0, 10)
  const since7 = new Date(Date.parse(until) - 6 * 86400000).toISOString().slice(0, 10)
  const activeCamps: { id: string; name: string }[] = []
  let next: string | null = `https://graph.facebook.com/v22.0/act_${BM2}/campaigns?fields=name,effective_status&limit=500&effective_status=${encodeURIComponent('["ACTIVE"]')}&access_token=${encodeURIComponent(metaToken)}`
  while (next) { const j: any = await (await fetch(next)).json(); if (j.error) throw new Error(j.error.message); activeCamps.push(...j.data); next = j.paging?.next || null }
  const spend7 = (await pool.query(`SELECT campaign_name, SUM(spend)::float AS spend FROM meta_daily_insights WHERE account_id = $1 AND level = 'campaign' AND date BETWEEN $2 AND $3 GROUP BY 1`, [BM2, since7, until])).rows
  const lastSpend = (await pool.query(`SELECT campaign_name, MAX(date)::text AS d FROM meta_daily_insights WHERE account_id = ANY($1) AND level = 'campaign' AND spend > 0 GROUP BY 1`, [[BM2, '1007481743408819']])).rows
  console.log(`Meta: ${activeCamps.length} ACTIVE campaigns on BM2; spend window ${since7}..${until}`)

  const clients = (await pool.query(`SELECT name, campaign_filter, ghl_token_enc, ghl_location_id, ghl_leads_tag FROM clients
    WHERE name ILIKE 'alloy%' AND name NOT ILIKE 'alloy ops%' AND name NOT ILIKE '%test%' AND active ORDER BY name`)).rows
    // optional ONLY="exact name;exact name" env var: pull just those locations (results merged into the month file by the caller)
    .filter(c => !process.env.ONLY || process.env.ONLY.split(';').map(s => s.trim()).includes(c.name))
  const out: any[] = []
  for (const c of clients) {
    const row: any = { name: c.name }
    out.push(row)
    // ---- Meta status
    const act = activeCamps.filter(k => matchesFilter(k.name, c.campaign_filter))
    const s7 = spend7.filter(r => matchesFilter(r.campaign_name, c.campaign_filter)).reduce((s, r) => s + r.spend, 0)
    const ls = lastSpend.filter(r => matchesFilter(r.campaign_name, c.campaign_filter)).map(r => r.d).sort().pop() || null
    row.meta = { active_campaigns: act.length, spend_7d: Math.round(s7 * 100) / 100, last_spend: ls, window: `${since7}..${until}`,
      status: act.length && s7 > 0 ? 'Active' : act.length ? 'Campaign on, $0 spend in last 7 days' : 'No active campaign' }

    // ---- GHL leads
    if (!c.ghl_token_enc || !c.ghl_location_id) { row.ghl = { status: 'no GHL connection' }; continue }
    const token = decrypt(c.ghl_token_enc)
    const tags = (c.ghl_leads_tag || '').split('|').map((t: string) => t.trim().toLowerCase()).filter(Boolean)
    const contacts: any[] = []
    let searchAfter: any
    for (let page = 0; page < 60; page++) {
      const j = await ghl('/contacts/search', token, { method: 'POST', body: { locationId: c.ghl_location_id, pageLimit: 100, ...(searchAfter ? { searchAfter } : {}),
        filters: [{ field: 'dateAdded', operator: 'range', value: { gte, lte } }], sort: [{ field: 'dateAdded', direction: 'asc' }] } })
      if (j.error) { row.ghl = { status: `contact search failed: ${j.error}` }; break }
      contacts.push(...(j.contacts || []))
      const lastC = j.contacts?.[j.contacts.length - 1]
      if (!j.contacts?.length || j.contacts.length < 100 || !lastC?.searchAfter) break
      searchAfter = lastC.searchAfter
    }
    if (row.ghl) continue
    // Exact Leads Tag, OR an offer variant of it ("new ad lead - gmn - 2 weeks free", "new ad lead - gmn challenge"):
    // clubs tag ads for other offers this way, and they are real ad leads (rule chosen for the Sep-2026 report on 2026-10-15, pending user confirmation).
    const exact = (t: string) => tags.includes(t.toLowerCase())
    const variant = (t: string) => !exact(t) && tags.some(base => t.toLowerCase().startsWith(base + ' '))
    const qualifies = (k: any) => tags.length ? (k.tags || []).some((t: string) => exact(t) || variant(t)) : !!k.attributionSource?.campaign
    const tagged = contacts.filter(qualifies)
    // counted via an offer-variant tag only (no exact Leads Tag on the contact)
    const variants: Record<string, number> = {}
    for (const k of tagged) if (!(k.tags || []).some(exact)) for (const t of (k.tags || []).filter(variant)) variants[t] = (variants[t] || 0) + 1
    // other "new ad lead…" spellings that are NOT variants of the Leads Tag (reported, not counted)
    const otherTags: Record<string, number> = {}
    for (const k of contacts.filter(k => !qualifies(k))) for (const t of k.tags || []) if (/new ad lead/i.test(t)) otherTags[t] = (otherTags[t] || 0) + 1
    // returning leads: form submission in the month by a qualifying contact added before the month (counted, user 2026-10-15)
    const septIds = new Set(contacts.map(k => k.id))
    const subs: any[] = []
    for (let page = 1; page <= 50; page++) {
      const j = await ghl(`/forms/submissions?locationId=${c.ghl_location_id}&startAt=${monthStart}&endAt=${monthEnd}&limit=100&page=${page}`, token)
      if (j.error) { row.submissions_error = j.error; break }
      subs.push(...(j.submissions || []))
      if (!j.meta?.nextPage || (j.submissions || []).length < 100) break
    }
    const firstSub = new Map<string, string>()
    for (const s of subs) if (s.contactId && s.createdAt && (!firstSub.has(s.contactId) || s.createdAt < firstSub.get(s.contactId)!)) firstSub.set(s.contactId, s.createdAt)
    const returningContacts: any[] = []
    for (const id of Array.from(firstSub.keys()).filter(id => !septIds.has(id))) {
      const j = await ghl(`/contacts/${id}`, token)
      const k = j.contact
      if (k && qualifies(k) && Date.parse(k.dateAdded) < Date.parse(gte)) returningContacts.push(k)
    }
    // One pool of September leads: new (dated by dateAdded) + returning (dated by their first September form), earliest first.
    const pool_ = [
      ...tagged.map(k => ({ k, kind: 'new', when: k.dateAdded })),
      ...returningContacts.map(k => ({ k, kind: 'returning', when: firstSub.get(k.id)! })),
    ].sort((a, b) => Date.parse(a.when) - Date.parse(b.when))
    const isTest = (k: any) => TEST_RE.test(`${k.firstName || ''} ${k.lastName || ''}`) || /(^|[._-])test/i.test((k.email || '').split('@')[0]) || /@(test|example)\./i.test(k.email || '')
    const tests = pool_.filter(x => isTest(x.k))
    // duplicates: same phone (last 10 digits), same email, or same full name (first + last both present); earliest kept.
    // The report builder removes only those whose match includes "same full name" (user, 2026-10-16); the rest are noted and kept.
    const keptByKey = new Map<string, any>()
    const dups: any[] = []
    const kept: any[] = []
    const LABEL: Record<string, string> = { p: 'same phone', e: 'same email', n: 'same full name' }
    for (const x of pool_.filter(x => !isTest(x.k))) {
      const k = x.k
      const fullName = `${(k.firstName || '').trim()} ${(k.lastName || '').trim()}`.toLowerCase().replace(/\s+/g, ' ')
      const keys = [phoneKey(k.phone) && `p:${phoneKey(k.phone)}`, (k.email || '').trim() && `e:${k.email.trim().toLowerCase()}`,
        (k.firstName || '').trim() && (k.lastName || '').trim() && `n:${fullName}`].filter(Boolean) as string[]
      const hitKey = keys.find(key => keptByKey.has(key))
      if (hitKey) {
        const first = keptByKey.get(hitKey)
        const on = keys.filter(key => keptByKey.get(key) === first).map(key => LABEL[key[0]]).join(' + ')
        dups.push({ id: k.id, name: short(k), kind: x.kind, added: k.dateAdded, when: x.when, dup_of_id: first.k.id, dup_of_name: short(first.k), dup_of_kind: first.kind, on })
        continue
      }
      kept.push(x)
      for (const key of keys) keptByKey.set(key, x)
    }
    row.ghl = {
      status: 'ok', leads_tag: c.ghl_leads_tag || '(none: attributed contacts)', contacts_added: contacts.length, tagged: tagged.length,
      returning_found: returningContacts.length,
      tests: tests.map(x => ({ id: x.k.id, name: short(x.k), kind: x.kind, email_domain: (x.k.email || '').split('@')[1] || '', added: x.k.dateAdded })),
      duplicates: dups,
      final_new: kept.filter(x => x.kind === 'new').length,
      final_returning: kept.filter(x => x.kind === 'returning').length,
      final: kept.length,
      returning: kept.filter(x => x.kind === 'returning').map(x => ({ id: x.k.id, name: short(x.k), first_added: x.k.dateAdded.slice(0, 10), form_in_month: x.when.slice(0, 10) })),
      tag_variants: variants, other_tags: otherTags,
    }
    await sleep(250)
  }
  writeFileSync(OUT, JSON.stringify({ month: MONTH, tz: TZ, meta_window: `${since7}..${until}`, generatedAt: new Date().toISOString(), rows: out }, null, 1))
  for (const r of out) {
    const g = r.ghl
    console.log(`${r.name.padEnd(50).slice(0, 50)} | ${r.meta.status.padEnd(36)} $${String(r.meta.spend_7d).padStart(8)} | ${g.status === 'ok'
      ? `GHL ${String(g.final).padStart(3)} (new tagged ${g.tagged} + returning ${g.returning_found}, -${g.tests.length} test, -${g.duplicates.length} dup${g.duplicates.length ? ' [' + g.duplicates.map((d: any) => d.on).join(', ') + ']' : ''})${Object.keys(g.tag_variants).length ? ' +variants ' + JSON.stringify(g.tag_variants) : ''}${Object.keys(g.other_tags).length ? ' other ' + JSON.stringify(g.other_tags) : ''}` : g.status}`)
  }
  await pool.end()
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1) })
