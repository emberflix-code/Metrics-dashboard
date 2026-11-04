// Coach board column catalog — shared by the server (prefs validation,
// metrics route) and the board UI. Plain module (no 'use client') so both
// sides can import it.
//
// kind 'config' = comes with the page (client settings); 'metric' = loaded
// after the page renders, from the cache only. cost 'slow' = needs live GHL
// calls, so it's opt-in and loaded separately.

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
  { key: 'channels', label: 'Channels', kind: 'config', cost: 'cheap', align: 'left', help: 'Meta | Google — dimmed when not set up' },
  { key: 'leads_source', label: 'Leads From', kind: 'config', cost: 'cheap', align: 'left', help: 'Where the client dashboard counts leads: Meta, Sheet or GHL' },
  { key: 'contact', label: 'Owner', kind: 'config', cost: 'cheap', align: 'left' },
  { key: 'location', label: 'Location', kind: 'config', cost: 'cheap', align: 'left' },
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
  { key: 'ghl_leads', label: 'GHL Leads', kind: 'metric', cost: 'slow', align: 'right', help: 'Live from GoHighLevel — loads slower, only for clients with GHL connected' },
  { key: 'ghl_bookings', label: 'GHL Bookings', kind: 'metric', cost: 'slow', align: 'right', help: 'Live from GoHighLevel — loads slower, only for clients with GHL connected' },
];

export const COLUMN_BY_KEY = new Map(BOARD_COLUMNS.map(c => [c.key, c] as const));
export const CHEAP_METRIC_KEYS = BOARD_COLUMNS.filter(c => c.kind === 'metric' && c.cost === 'cheap').map(c => c.key);
export const SLOW_METRIC_KEYS = BOARD_COLUMNS.filter(c => c.kind === 'metric' && c.cost === 'slow').map(c => c.key);

export function defaultColumns(isAdmin: boolean): string[] {
  return ['offer', ...(isAdmin ? ['coach'] : []), 'channels', 'spend', 'leads', 'cpl', 'g_spend', 'g_leads'];
}

/** Keep known keys only, in the given order, without duplicates. */
export function sanitizeColumns(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) if (typeof k === 'string' && COLUMN_BY_KEY.has(k) && !out.includes(k)) out.push(k);
  return out;
}

export const RANGE_PRESETS = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7', label: 'Last 7 days' },
  { key: '14', label: 'Last 14 days' },
  { key: '30', label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
] as const;
export const RANGE_KEYS: string[] = RANGE_PRESETS.map(r => r.key);

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
}

export function defaultPrefs(isAdmin: boolean): CoachBoardPrefs {
  return { columns: defaultColumns(isAdmin), groupBy: 'marketing_type', range: '7', collapsed: [], coachFilter: '' };
}
