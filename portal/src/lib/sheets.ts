// Shared Google Sheets fetch helper used by /api/sheets/meta and /api/sheets/google.
//
// Two modes, switched by the presence of `,` in the tab spec:
//   - literal:  "Alloy Middleton, WI"            → one tab's CSV
//   - multi:    "Alloy Middleton, WI | Alloy Wexford, PA | Alloy West Arvada, CO"
//                 → union rows across each listed tab
//
// The multi mode powers the "Alloy Ops" umbrella client — admin pastes the
// exact tab names of every Alloy location into one client's config without
// having to maintain a parent/child client relationship in the schema.
//
// We chose pipe-separated explicit lists over prefix-based enumeration because
// Google's htmlview / preview pages no longer expose a static tab list (the
// real DOM is built by client-side JS) and no auth-free public API exposes
// it either. Explicit lists are also more robust to typos and renames — the
// admin sees exactly which tabs are being aggregated.
//
// All fetches assume the sheet is shared as "Anyone with the link can view".

export interface SheetRow {
  campaign: string;
  day: string;          // ISO YYYY-MM-DD
  spend: number;
  leads: number;
  impressions: number;
  linkClicks: number;
}

export interface SheetFetchResult {
  rows: SheetRow[];
  mode: 'literal' | 'multi';
  tabsFetched: string[];
  failedTabs: string[];
}

export class SheetError extends Error {
  code:
    | 'NOT_PUBLIC'
    | 'MISSING_COLUMNS'
    | 'UPSTREAM_5XX'
    | 'EMPTY_TAB_SPEC'
    | 'TAB_NOT_FOUND';
  status: number;
  constructor(code: SheetError['code'], message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Google's gviz CSV export does NOT error when `sheet=<name>` fails to
// resolve — it silently falls back to the spreadsheet's first/default tab
// (gid=0) and returns HTTP 200 with that tab's data, indistinguishable in
// shape from a correct response. This bit a real client: a renamed tab
// ("Alloy West Las Vegas" → "Alloy Personal Training West Las Vegas, NV")
// left every request for the old name silently serving an unrelated
// client's numbers for weeks with no error anywhere. Since there's no
// signal in the response itself, verify indirectly: strip common noise
// words from the requested tab name and require the remaining distinctive
// words to appear in at least one returned campaign name. False negatives
// (a real tab whose campaigns don't happen to mention the location) are
// safe — this only widens what's accepted, never narrows a legitimate tab
// out. A completely wrong tab (different location's campaigns throughout)
// reliably fails this check.
const NOISE_WORDS = new Set(['gmn', 'alloy', 'personal', 'training', 'the', 'and']);
function significantWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !NOISE_WORDS.has(w));
}
function tabLikelyMatches(tabName: string, rows: { campaign: string }[]): boolean {
  const wanted = significantWords(tabName);
  if (wanted.length === 0) return true; // nothing distinctive to check against
  const campaignWords = new Set(rows.flatMap(r => significantWords(r.campaign)));
  return wanted.some(w => campaignWords.has(w));
}

// ── Cache ────────────────────────────────────────────────────────────────────
const TTL_MS = 60_000;
const _csvCache = new Map<string, { expires: number; rows: SheetRow[] }>();

// ── CSV helpers (factored out of the route files) ────────────────────────────
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else { cell += c; }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
function pad2(n: number): string { return String(n).padStart(2, '0'); }

// The "Day" column is a genuine Date-typed cell, so its rendered text
// follows whatever locale/number-format the sheet (or that column) happens
// to be set to — M/D/YYYY today, but an admin changing column formatting or
// the sheet's locale could switch it to D/M/YYYY, "Mon D, YYYY", or Sheets'
// own gviz Date(y,m,d) serialization with no warning. All of these must
// resolve to the same ISO string or a day's leads silently vanish (the row
// gets dropped by fetchOneTabCsv when this returns null).
export function normalizeDay(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return `${iso[1]}-${pad2(+iso[2])}-${pad2(+iso[3])}`;

  // Google's gviz JSON responses encode dates as Date(y,m,d) with a
  // zero-based month; some export paths can surface this literally.
  const gviz = /^Date\((\d{4}),(\d{1,2}),(\d{1,2})\)$/.exec(s);
  if (gviz) return `${gviz[1]}-${pad2(+gviz[2] + 1)}-${pad2(+gviz[3])}`;

  // M/D/YYYY (US default, what this sheet uses today).
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (mdy) {
    const a = +mdy[1], b = +mdy[2];
    let y = mdy[3];
    if (y.length === 2) y = (parseInt(y, 10) >= 70 ? '19' : '20') + y;
    // Only the M/D reading is ambiguous when both parts are <=12; if the
    // first number can't be a month (>12), treat it as D/M instead of
    // silently misparsing or dropping the row.
    if (a > 12 && b <= 12) return `${y}-${pad2(b)}-${pad2(a)}`;
    return `${y}-${pad2(a)}-${pad2(b)}`;
  }

  // "Jul 20, 2026" / "20 Jul 2026" / "Jul-20-2026" style — covers common
  // alternate column-format choices without needing a full date library.
  const named = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)
    || /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s);
  if (named) {
    const monthFirst = /^[A-Za-z]/.test(named[1]);
    const monthStr = (monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase();
    const day = monthFirst ? named[2] : named[1];
    const year = named[3];
    const month = MONTH_NAMES[monthStr];
    if (month) return `${year}-${pad2(month)}-${pad2(+day)}`;
  }

  return null;
}

export function parseNum(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[$,%\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// ── Single-tab CSV fetch ─────────────────────────────────────────────────────
async function fetchOneTabCsv(sheetId: string, tabName: string): Promise<SheetRow[]> {
  const cacheKey = `${sheetId}|${tabName}`;
  const hit = _csvCache.get(cacheKey);
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
    _csvCache.set(cacheKey, { expires: Date.now() + TTL_MS, rows: [] });
    return [];
  }
  const headers = values[0].map(h => (h || '').trim().toLowerCase());
  const idx = (name: string) => headers.findIndex(h => h === name);
  const cCampaign = idx('campaign name');
  const cSpend = idx('amount spent');
  const cLeads = idx('leads');
  const cImpressions = idx('impressions');
  const cLinkClicks = headers.findIndex(h => h.startsWith('link clicks'));
  const cDay = idx('day');

  if (cCampaign < 0 || cDay < 0) {
    throw new SheetError('MISSING_COLUMNS', `Sheet tab "${tabName}" is missing required columns (Campaign Name, Day).`);
  }

  const rows: SheetRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const campaign = (r[cCampaign] || '').trim();
    const day = normalizeDay(r[cDay] || '');
    if (!campaign || !day) continue;
    rows.push({
      campaign,
      day,
      spend: parseNum(r[cSpend] ?? ''),
      leads: Math.round(parseNum(r[cLeads] ?? '')),
      impressions: Math.round(parseNum(r[cImpressions] ?? '')),
      linkClicks: Math.round(parseNum(r[cLinkClicks] ?? '')),
    });
  }

  if (rows.length > 0 && !tabLikelyMatches(tabName, rows)) {
    throw new SheetError(
      'TAB_NOT_FOUND',
      `Sheet tab "${tabName}" did not resolve to matching data (Google silently serves the default tab for an unknown name) — check the tab still exists under this exact name.`,
      404
    );
  }

  _csvCache.set(cacheKey, { expires: Date.now() + TTL_MS, rows });
  return rows;
}

// ── Concurrency-capped parallel map ──────────────────────────────────────────
// `Promise.allSettled` over 30+ tabs hammers docs.google.com from a single
// server process and can get throttled. Cap at 10 in-flight at a time.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i]);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Public entry point ───────────────────────────────────────────────────────
//
// Tab spec parsing:
//   - Trim and reject empty input
//   - Split on `|` (pipe). Tab names contain commas (e.g. "Alloy Middleton, WI"),
//     so we cannot use commas as the delimiter. Pipe is rare in tab names.
//   - Single segment → literal mode (1:1 with pre-multi behavior)
//   - Multiple segments → multi mode, fetch each in parallel, union the rows
export async function fetchSheetRows(sheetId: string, tabSpec: string): Promise<SheetFetchResult> {
  const trimmed = (tabSpec || '').trim();
  if (!trimmed) throw new SheetError('EMPTY_TAB_SPEC', 'Sheet tab is not configured for this client.', 400);

  const tabs = trimmed.split('|').map(t => t.trim()).filter(Boolean);

  if (tabs.length === 1) {
    // Literal mode — single tab, identical to pre-refactor behavior.
    const rows = await fetchOneTabCsv(sheetId, tabs[0]);
    return { rows, mode: 'literal', tabsFetched: [tabs[0]], failedTabs: [] };
  }

  // Multi mode — fetch each tab in parallel with a concurrency cap.
  const settled = await mapWithConcurrency(tabs, 10, t => fetchOneTabCsv(sheetId, t));
  const tabsFetched: string[] = [];
  const failedTabs: string[] = [];
  const rows: SheetRow[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const tabName = tabs[i];
    if (result.status === 'fulfilled') {
      tabsFetched.push(tabName);
      // Duplicates across tabs are not deduped — each location's `campaign`
      // differs, so summing is correct.
      for (const r of result.value) rows.push(r);
    } else {
      failedTabs.push(tabName);
    }
  }
  return { rows, mode: 'multi', tabsFetched, failedTabs };
}
