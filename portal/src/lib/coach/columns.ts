// Coach board column catalog — shared by the server (prefs validation,
// metrics route) and the board UI. Plain module (no 'use client') so both
// sides can import it.
//
// kind 'config' = comes with the page (client settings); 'metric' = loaded
// after the page renders, from the cache only. cost 'slow' = needs live GHL
// calls, so it's opt-in and loaded separately.

import { DEFAULT_RANGE } from './dateRange';

export type ColumnKind = 'config' | 'metric';

export interface BoardColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  cost: 'cheap' | 'slow';
  align: 'left' | 'right' | 'center';
  help?: string;
}

export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'offer', label: 'Offer', kind: 'config', cost: 'cheap', align: 'left' },
  { key: 'marketing_type', label: 'Marketing Type', kind: 'config', cost: 'cheap', align: 'left' },
  { key: 'coach', label: 'Coach', kind: 'config', cost: 'cheap', align: 'left' },
  { key: 'channels', label: 'Platform', kind: 'config', cost: 'cheap', align: 'left', help: 'Meta | Google — dimmed when not set up' },
  { key: 'leads_source', label: 'Leads From', kind: 'config', cost: 'cheap', align: 'left', help: 'Where the client dashboard counts leads: Meta, Sheet or GHL' },
  { key: 'contact', label: 'Owner', kind: 'config', cost: 'cheap', align: 'left' },
  { key: 'launch_date', label: 'Launch Date', kind: 'config', cost: 'cheap', align: 'left', help: 'From the marketing sheet — hover a date to see how long ago it was' },
  { key: 'location', label: 'Location', kind: 'config', cost: 'cheap', align: 'left' },
  { key: 'data_source', label: 'Meta Data', kind: 'config', cost: 'cheap', align: 'center', help: 'Cached = synced daily (fast); Live = fetched from Meta on every load' },
  { key: 'creatives_v3', label: 'Creatives v3', kind: 'config', cost: 'cheap', align: 'center', help: 'Creatives v3 tab switched on for the client' },
  { key: 'ghl', label: 'GHL Token', kind: 'config', cost: 'cheap', align: 'center', help: 'GoHighLevel location + token connected' },
  { key: 'bookings_on', label: 'Shows Bookings', kind: 'config', cost: 'cheap', align: 'center', help: 'Bookings card shown on the client dashboard' },
  { key: 'cpa_on', label: 'CPA On', kind: 'config', cost: 'cheap', align: 'center', help: 'CPA card shown on the client dashboard (needs a CPA sheet tab)' },
  { key: 'ltv_on', label: 'LTV On', kind: 'config', cost: 'cheap', align: 'center', help: 'LTV card shown on the client dashboard' },
  { key: 'spend', label: 'Meta Spend', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'leads', label: 'Meta Leads', kind: 'metric', cost: 'cheap', align: 'right', help: "Meta-reported results. A client whose dashboard uses Sheet or GHL leads can show a different number there." },
  { key: 'cpl', label: 'Meta CPL', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'impressions', label: 'Impressions', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'reach', label: 'Reach', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'link_clicks', label: 'Link Clicks', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'ctr', label: 'CTR', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'g_spend', label: 'Google Spend', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'g_leads', label: 'Google Leads', kind: 'metric', cost: 'cheap', align: 'right', help: "Google Ads lead-form conversions" },
  { key: 'g_cpl', label: 'Google CPL', kind: 'metric', cost: 'cheap', align: 'right' },
  { key: 'total_spend', label: 'Total Spend', kind: 'metric', cost: 'cheap', align: 'right', help: 'Meta + Google' },
  { key: 'spend_delta', label: 'Spend vs Prev.', kind: 'metric', cost: 'cheap', align: 'right', help: 'Meta + Google spend vs the previous period of the same length' },
  { key: 'ghl_leads', label: 'GHL Leads', kind: 'metric', cost: 'slow', align: 'right', help: 'Live from GoHighLevel — click the eye on a row to load it (clients with GHL connected)' },
  { key: 'ghl_bookings', label: 'GHL Bookings', kind: 'metric', cost: 'slow', align: 'right', help: 'Live from GoHighLevel — click the eye on a row to load it (clients with GHL connected)' },
  { key: 'won', label: 'Won Sales', kind: 'metric', cost: 'slow', align: 'right', help: "Won rows on the client's CPA sheet tab — click the eye on a row to load it (clients with CPA on)" },
  { key: 'cpa', label: 'CPA', kind: 'metric', cost: 'slow', align: 'right', help: '(Meta spend + retainer) ÷ won sales, same as the CPA card — click the eye on a row to load it' },
  { key: 'ltv', label: 'LTV', kind: 'metric', cost: 'slow', align: 'right', help: "Won sales × the client's LTV value, same as the LTV card — click the eye on a row to load it" },
];

// Default column widths (px). 'name' = the Client column, 'actions' = the buttons column.
const DEFAULT_WIDTHS: Record<string, number> = {
  name: 280, actions: 190, offer: 260, marketing_type: 150, coach: 170, channels: 140, leads_source: 110,
  contact: 160, location: 220, launch_date: 150, data_source: 110, creatives_v3: 110, ghl: 100,
  bookings_on: 120, cpa_on: 90, ltv_on: 90,
};
export const MIN_COL_WIDTH = 60;
export const MAX_COL_WIDTH = 1000;
export function defaultColumnWidth(key: string): number {
  return DEFAULT_WIDTHS[key] ?? 120;
}

export const COLUMN_BY_KEY = new Map(BOARD_COLUMNS.map(c => [c.key, c] as const));
export const CHEAP_METRIC_KEYS = BOARD_COLUMNS.filter(c => c.kind === 'metric' && c.cost === 'cheap').map(c => c.key);
export const SLOW_METRIC_KEYS = BOARD_COLUMNS.filter(c => c.kind === 'metric' && c.cost === 'slow').map(c => c.key);
export const GHL_METRIC_KEYS = ['ghl_leads', 'ghl_bookings'];
export const CPA_METRIC_KEYS = ['won', 'cpa', 'ltv'];

export function defaultColumns(isAdmin: boolean): string[] {
  return ['offer', ...(isAdmin ? ['coach'] : []), 'channels', 'launch_date', 'spend', 'leads', 'cpl', 'g_spend', 'g_leads'];
}

/** Keep known keys only, in the given order, without duplicates. */
export function sanitizeColumns(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) if (typeof k === 'string' && COLUMN_BY_KEY.has(k) && !out.includes(k)) out.push(k);
  return out;
}

export const GROUP_BY_OPTIONS = [
  { key: 'marketing_type', label: 'Marketing Type' },
  { key: 'offer', label: 'Offer' },
  { key: 'coach', label: 'Coach' },
  { key: 'none', label: 'No grouping' },
] as const;
export const GROUP_BY_KEYS: string[] = GROUP_BY_OPTIONS.map(g => g.key);

export interface CoachBoardPrefs {
  columns: string[];
  groupBy: string;
  range: string;
  collapsed: string[];
  coachFilter: string;
  /** Rows whose per-row (eye) numbers stay shown: 'ghl:<clientId>' / 'cpa:<clientId>'. */
  revealed: string[];
  /** Column sort inside each group: '<key>:asc|desc', '' = by name. */
  sort: string;
  /** Column widths the user dragged (px), by column key ('name' = Client, 'actions'). Missing = default. */
  widths: Record<string, number>;
}

export function defaultPrefs(isAdmin: boolean): CoachBoardPrefs {
  return { columns: defaultColumns(isAdmin), groupBy: 'marketing_type', range: DEFAULT_RANGE, collapsed: [], coachFilter: '', revealed: [], sort: '', widths: {} };
}

/** 'ghl:<id>' / 'cpa:<id>' entries only, capped. */
export function sanitizeRevealed(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && /^(ghl|cpa):[0-9a-f-]{36}$/.test(x)))).slice(0, 300);
}

/** Known column keys (plus 'name'/'actions') with whole-pixel widths inside the allowed range. */
export function sanitizeWidths(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if ((k === 'name' || k === 'actions' || COLUMN_BY_KEY.has(k)) && typeof w === 'number' && Number.isFinite(w)) {
      out[k] = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(w)));
    }
  }
  return out;
}

export function sanitizeSort(v: unknown): string {
  const m = /^([a-z_]+):(asc|desc)$/.exec(String(v ?? ''));
  return m && (m[1] === 'name' || COLUMN_BY_KEY.has(m[1])) ? m[0] : '';
}
