// Fetches a per-client "won leads" Google Sheet for the CPA KPI card.
//
// Unlike sheets.ts (per-campaign/day rollups keyed by "Campaign Name" +
// "Day"), this sheet is one row per lead: First Name, Last Name, Phone,
// Email, Date Enrolled, Notes. There is no dedicated boolean "won" column in
// practice — sales reps prefix the Notes cell with "Won:" / "Lost:" / "Open:"
// — so a row counts as an acquisition when Notes starts with "Won"
// (case-insensitive).
//
// Reuses the same public gviz CSV export as sheets.ts (sheet must be shared
// "Anyone with the link can view") and the same CSV/date parsing helpers.

import { parseCsv, normalizeDay, SheetError } from './sheets';

export interface AcquisitionRow {
  day: string; // ISO YYYY-MM-DD, from "Date Enrolled"
  won: boolean;
  name: string; // "First Last", for the CPA card's lead-name drilldown
}

export interface AcquisitionFetchResult {
  rows: AcquisitionRow[];
  tabsFetched: string[];
  failedTabs: string[];
}

const TTL_MS = 60_000;
const _cache = new Map<string, { expires: number; rows: AcquisitionRow[] }>();

function isWon(notes: string): boolean {
  return /^\s*won\b/i.test(notes || '');
}

async function fetchOneTab(sheetId: string, tabName: string): Promise<AcquisitionRow[]> {
  const cacheKey = `${sheetId}|${tabName}`;
  const hit = _cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.rows;

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new SheetError('UPSTREAM_5XX', `Sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  if (csv.trim().startsWith('<')) {
    throw new SheetError('NOT_PUBLIC', 'Sheet is not publicly viewable. Set sharing to "Anyone with the link".');
  }

  const values = parseCsv(csv);
  if (values.length < 2) {
    _cache.set(cacheKey, { expires: Date.now() + TTL_MS, rows: [] });
    return [];
  }
  const headers = values[0].map(h => (h || '').trim().toLowerCase());
  const idx = (name: string) => headers.findIndex(h => h === name);
  const cDateEnrolled = idx('date enrolled');
  const cNotes = idx('notes');
  const cFirstName = idx('first name');
  const cLastName = idx('last name');

  if (cDateEnrolled < 0) {
    throw new SheetError('MISSING_COLUMNS', `Sheet tab "${tabName}" is missing the required "Date Enrolled" column.`);
  }

  const rows: AcquisitionRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const day = normalizeDay(r[cDateEnrolled] || '');
    if (!day) continue;
    const first = (cFirstName >= 0 ? r[cFirstName] : '') || '';
    const last = (cLastName >= 0 ? r[cLastName] : '') || '';
    rows.push({
      day,
      won: isWon(cNotes >= 0 ? (r[cNotes] || '') : ''),
      name: `${first.trim()} ${last.trim()}`.trim(),
    });
  }

  _cache.set(cacheKey, { expires: Date.now() + TTL_MS, rows });
  return rows;
}

// Tab spec parsing mirrors sheets.ts: '|'-separated list, single segment is
// the common case, multiple tabs union their rows (e.g. an umbrella client).
export async function fetchAcquisitionRows(sheetId: string, tabSpec: string): Promise<AcquisitionFetchResult> {
  const trimmed = (tabSpec || '').trim();
  if (!trimmed) throw new SheetError('EMPTY_TAB_SPEC', 'CPA sheet tab is not configured for this client.', 400);

  const tabs = trimmed.split('|').map(t => t.trim()).filter(Boolean);
  const tabsFetched: string[] = [];
  const failedTabs: string[] = [];
  const rows: AcquisitionRow[] = [];

  const settled = await Promise.allSettled(tabs.map(t => fetchOneTab(sheetId, t)));
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const tabName = tabs[i];
    if (result.status === 'fulfilled') {
      tabsFetched.push(tabName);
      for (const r of result.value) rows.push(r);
    } else {
      failedTabs.push(tabName);
    }
  }
  return { rows, tabsFetched, failedTabs };
}
