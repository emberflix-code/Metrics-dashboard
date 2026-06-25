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
    | 'EMPTY_TAB_SPEC';
  status: number;
  constructor(code: SheetError['code'], message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
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

export function normalizeDay(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (mdy) {
    const m = mdy[1].padStart(2, '0');
    const d = mdy[2].padStart(2, '0');
    let y = mdy[3];
    if (y.length === 2) y = (parseInt(y, 10) >= 70 ? '19' : '20') + y;
    return `${y}-${m}-${d}`;
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
