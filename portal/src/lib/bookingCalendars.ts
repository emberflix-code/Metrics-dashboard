// Syncs the marketing team's booking-calendar sheet (Location | Calendar
// Name | Platform | Calendar Link) onto clients.booking_calendar_*.
//
// The sheet names locations loosely ("Alloy Middleton", "Alloy NorthPointe",
// "Alloy Personal Training Bonney Lake") while client names are the dashboard
// names ("Alloy Personal Training - Middleton, WI"). Matching is by
// normalized tokens with the brand/“Personal Training” noise and trailing
// state removed; anything ambiguous is reported, never guessed.
import { query } from './db';

export const BOOKING_CALENDAR_SHEET_ID = '1JFVzMkEBqWsY157j3UsUk0mvbhde2h_Gx4_Auy0fURM';
export const BOOKING_CALENDAR_SHEET_GID = '0';

export interface CalendarSheetRow { location: string; calendarName: string; platform: string; link: string }

// Minimal RFC 4180 CSV parser (gviz output quotes every cell).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

export async function fetchBookingCalendarSheet(sheetId = BOOKING_CALENDAR_SHEET_ID, gid = BOOKING_CALENDAR_SHEET_GID): Promise<CalendarSheetRow[]> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Booking calendar sheet HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (name: string) => header.findIndex(h => h === name);
  const iLoc = idx('location'), iCal = idx('calendar name'), iPlat = idx('platform'), iLink = idx('calendar link');
  if (iLoc < 0 || iCal < 0) throw new Error(`Booking calendar sheet: expected "Location" and "Calendar Name" columns, got: ${rows[0].filter(Boolean).join(' | ')}`);
  return rows.slice(1)
    .map(r => ({ location: (r[iLoc] || '').trim(), calendarName: (r[iCal] || '').trim(), platform: iPlat >= 0 ? (r[iPlat] || '').trim() : '', link: iLink >= 0 ? (r[iLink] || '').trim() : '' }))
    .filter(r => r.location && r.calendarName);
}

const NOISE = new Set(['alloy', 'personal', 'training', 'pt', 'the', 'and', 'of']);
const STATES = new Set(['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','bc','ab','on','qc']);

/** Location name -> comparable token key ("Alloy Personal Training - Middleton, WI" -> "middleton"). */
export function locationKey(name: string): string {
  const tokens = name.toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/)
    .filter(t => t && !NOISE.has(t));
  // Trailing state abbreviation is address noise, not identity.
  while (tokens.length > 1 && STATES.has(tokens[tokens.length - 1])) tokens.pop();
  // "NorthPointe" vs "North Pointe", "St." vs "St" — compare without spaces.
  return tokens.join('');
}

export interface CalendarSyncReport {
  matched: { client: string; location: string; calendar: string; platform: string }[];
  unmatched: string[];
  ambiguous: { location: string; candidates: string[] }[];
  updated: number;
}

/** Matches sheet rows to active non-rollup clients and (unless dry) writes the calendar columns. */
export async function syncBookingCalendars(opts: { dry?: boolean } = {}): Promise<CalendarSyncReport> {
  const [sheet, clients] = await Promise.all([
    fetchBookingCalendarSheet(),
    query<{ id: string; name: string }>(`SELECT id, name FROM clients WHERE active = true AND is_rollup = false`),
  ]);
  const byKey = new Map<string, { id: string; name: string }[]>();
  for (const c of clients) {
    const k = locationKey(c.name);
    const arr = byKey.get(k) ?? [];
    arr.push(c);
    byKey.set(k, arr);
  }
  const report: CalendarSyncReport = { matched: [], unmatched: [], ambiguous: [], updated: 0 };
  const seenClient = new Set<string>();

  for (const row of sheet) {
    const k = locationKey(row.location);
    let candidates = byKey.get(k) ?? [];
    if (candidates.length === 0) {
      // Loose fallback: the sheet key is contained in exactly one client key
      // ("westlosangeles" vs "westla" won't match; "bonneylake" ⊂ "bonneylake" will).
      const loose = clients.filter(c => { const ck = locationKey(c.name); return ck.includes(k) || k.includes(ck); });
      candidates = loose;
    }
    if (candidates.length === 0) { report.unmatched.push(row.location); continue; }
    if (candidates.length > 1) { report.ambiguous.push({ location: row.location, candidates: candidates.map(c => c.name) }); continue; }
    const c = candidates[0];
    if (seenClient.has(c.id)) { report.ambiguous.push({ location: row.location, candidates: [`${c.name} (already matched by another row)`] }); continue; }
    seenClient.add(c.id);
    report.matched.push({ client: c.name, location: row.location, calendar: row.calendarName, platform: row.platform });
    if (!opts.dry) {
      await query(
        `UPDATE clients SET booking_calendar_name = $2, booking_platform = $3, booking_calendar_link = $4, booking_calendar_synced_at = now() WHERE id = $1`,
        [c.id, row.calendarName, row.platform, row.link]
      );
      report.updated++;
    }
  }
  return report;
}
