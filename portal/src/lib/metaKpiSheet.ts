// Fetch helper for the "Meta KPI sheet" — a per-client Google Sheet (Apps
// Script export, "Account" tab in the reference sheet) that carries the same
// Meta insights the app already syncs PLUS fields Meta's API has no concept
// of: Campaign Type, Offer, Location Name, State, Landing Page, and
// manually-tallied Bookings/Joins.
//
// This is deliberately a SEPARATE module from lib/sheets.ts rather than an
// extension of fetchSheetRows/SheetRow: that existing helper is hardcoded to
// a narrow 6-column shape (campaign name, amount spent, leads, impressions,
// link clicks, day) built for the leads-override use case, and this sheet's
// 31 columns don't fit it. Only the low-level, format-agnostic primitives
// (parseCsv, normalizeDay, parseNum, the gviz CSV URL) are reused.
//
// Single-tab-per-client only (no multi-tab pipe-union like fetchSheetRows) —
// this sheet's "Account" tab already spans every location for a client
// group, so there's no need to aggregate across multiple tabs the way the
// "Alloy Ops" umbrella client does for the leads sheet.

import { parseCsv, normalizeDay, parseNum, SheetError } from './sheets';

export interface MetaKpiSheetRow {
  campaign: string;
  day: string; // ISO YYYY-MM-DD, from "Reporting starts"
  spend: number;
  results: number;
  bookings: number;
  joins: number;
  campaignType: string;
  offer: string;
  locationName: string;
  state: string;
  landingPage: string;
}

export interface MetaKpiSheetFetchResult {
  rows: MetaKpiSheetRow[];
}

// Short-lived de-dupe cache, same rationale and TTL as lib/sheets.ts's
// _csvCache — exists to collapse a handful of near-simultaneous requests
// (e.g. two dashboard tabs open at once), not to serve stale data.
const TTL_MS = 10_000;
const _cache = new Map<string, { expires: number; rows: MetaKpiSheetRow[] }>();

export async function fetchMetaKpiSheetRows(sheetId: string, tabName: string): Promise<MetaKpiSheetFetchResult> {
  const trimmedTab = (tabName || '').trim();
  if (!sheetId || !trimmedTab) {
    throw new SheetError('EMPTY_TAB_SPEC', 'Meta KPI sheet is not configured for this client.', 400);
  }

  const cacheKey = `${sheetId}|${trimmedTab}`;
  const hit = _cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return { rows: hit.rows };

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(trimmedTab)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new SheetError('UPSTREAM_5XX', `Sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  if (csv.trim().startsWith('<')) {
    throw new SheetError('NOT_PUBLIC', 'Sheet is not publicly viewable. Set sharing to "Anyone with the link".');
  }

  const values = parseCsv(csv);
  if (values.length < 2) {
    _cache.set(cacheKey, { expires: Date.now() + TTL_MS, rows: [] });
    return { rows: [] };
  }

  const headers = values[0].map(h => (h || '').trim().toLowerCase());
  const idx = (name: string) => headers.findIndex(h => h === name);
  const cCampaign = idx('campaign name');
  const cDay = idx('reporting starts');
  const cSpend = idx('amount spent (usd)');
  const cResults = idx('results');
  const cBookings = idx('bookings');
  const cJoins = idx('joins');
  const cCampaignType = idx('campaign type');
  const cOffer = idx('offer');
  const cLocationName = idx('location name');
  const cState = idx('state');
  const cLandingPage = idx('landing page');

  // Only campaign + day are load-bearing for a row to be usable at all —
  // every other column is optional. The sheet's own column set may drift
  // (a column renamed/reordered/removed in the Apps Script export) and a
  // missing optional column should degrade that one dimension, not break
  // the whole feature.
  if (cCampaign < 0 || cDay < 0) {
    throw new SheetError(
      'MISSING_COLUMNS',
      `Sheet tab "${trimmedTab}" is missing required columns (Campaign name, Reporting starts).`
    );
  }

  const rows: MetaKpiSheetRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const campaign = (r[cCampaign] || '').trim();
    const day = normalizeDay(r[cDay] || '');
    if (!campaign || !day) continue;
    rows.push({
      campaign,
      day,
      spend: cSpend >= 0 ? parseNum(r[cSpend] ?? '') : 0,
      results: cResults >= 0 ? Math.round(parseNum(r[cResults] ?? '')) : 0,
      bookings: cBookings >= 0 ? Math.round(parseNum(r[cBookings] ?? '')) : 0,
      joins: cJoins >= 0 ? Math.round(parseNum(r[cJoins] ?? '')) : 0,
      campaignType: cCampaignType >= 0 ? (r[cCampaignType] || '').trim() : '',
      offer: cOffer >= 0 ? (r[cOffer] || '').trim() : '',
      locationName: cLocationName >= 0 ? (r[cLocationName] || '').trim() : '',
      state: cState >= 0 ? (r[cState] || '').trim() : '',
      landingPage: cLandingPage >= 0 ? (r[cLandingPage] || '').trim() : '',
    });
  }

  _cache.set(cacheKey, { expires: Date.now() + TTL_MS, rows });
  return { rows };
}
