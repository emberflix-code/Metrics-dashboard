// Coach board date ranges — same presets as the client dashboard's date
// picker (DashboardClient.tsx DP_PRESETS/_dpPresetRange): yesterday-anchored
// (today is never included), Sunday-start weeks, "Maximum" = Jan 1 of this
// year. The board spans many ad accounts, so days are counted in US Eastern
// time (the same day boundary the daily sync uses). Plain module so the board
// UI and the API routes resolve a range spec identically.
//
// A range spec is a preset key ('last_7d') or 'custom:YYYY-MM-DD:YYYY-MM-DD'.

export const BOARD_TZ = 'America/New_York';

export const COACH_RANGE_PRESETS = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last_7d', label: 'Last 7 days' },
  { key: 'last_14d', label: 'Last 14 days' },
  { key: 'last_28d', label: 'Last 28 days' },
  { key: 'last_30d', label: 'Last 30 days' },
  { key: 'this_week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'maximum', label: 'Maximum' },
] as const;

export const DEFAULT_RANGE = 'last_7d';
/** Earliest day the custom calendar allows. */
export const MIN_DAY = '2023-01-01';
const MAX_CUSTOM_DAYS = 800;

// Older saved settings used the Agency Overview keys.
const LEGACY: Record<string, string> = { '7': 'last_7d', '14': 'last_14d', '30': 'last_30d' };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD for a UTC-midnight Date used as a calendar-day handle. */
export function fmtDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function parseDay(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function addDays(s: string, n: number): string {
  const d = parseDay(s); d.setUTCDate(d.getUTCDate() + n); return fmtDay(d);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86400000);
}
function isRealDay(s: string): boolean {
  return DAY_RE.test(s) && fmtDay(parseDay(s)) === s;
}

/** Today's calendar day in the board timezone. */
export function boardToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: BOARD_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function boardYesterday(now: Date = new Date()): string {
  return addDays(boardToday(now), -1);
}

export interface ResolvedBoardRange { spec: string; preset: string; since: string; until: string; label: string }

/** Map any stored/requested spec to a valid one (legacy keys migrated, junk → default). */
export function normalizeRangeSpec(spec: unknown, now: Date = new Date()): string {
  const s = String(spec ?? '');
  if (LEGACY[s]) return LEGACY[s];
  return resolveBoardRange(s, now) ? s : DEFAULT_RANGE;
}

export function resolveBoardRange(spec: string, now: Date = new Date()): ResolvedBoardRange | null {
  const t = boardToday(now);
  const tEnd = addDays(t, -1);
  const max = (a: string, b: string) => (a > b ? a : b);
  const dow = parseDay(t).getUTCDay();
  const sow = addDays(t, -dow);
  const [y, m] = t.split('-').map(Number);
  const firstOfMonth = `${y}-${pad(m)}-01`;
  let since: string, until: string;
  switch (spec) {
    case 'yesterday': since = until = tEnd; break;
    case 'last_7d': since = addDays(tEnd, -6); until = tEnd; break;
    case 'last_14d': since = addDays(tEnd, -13); until = tEnd; break;
    case 'last_28d': since = addDays(tEnd, -27); until = tEnd; break;
    case 'last_30d': since = addDays(tEnd, -29); until = tEnd; break;
    // Clamp when "yesterday" falls before the start (Sunday / the 1st / Jan 1), like the client dashboard.
    case 'this_week': since = sow; until = max(sow, tEnd); break;
    case 'last_week': since = addDays(sow, -7); until = addDays(sow, -1); break;
    case 'this_month': since = firstOfMonth; until = max(firstOfMonth, tEnd); break;
    case 'last_month': since = fmtDay(new Date(Date.UTC(y, m - 2, 1))); until = addDays(firstOfMonth, -1); break;
    case 'maximum': since = `${y}-01-01`; until = max(since, tEnd); break;
    default: {
      const mm = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(spec);
      if (!mm) return null;
      [, since, until] = mm;
      if (!isRealDay(since) || !isRealDay(until) || since > until || until > tEnd || since < MIN_DAY) return null;
      if (daysBetween(since, until) > MAX_CUSTOM_DAYS) return null;
      return { spec, preset: 'custom', since, until, label: formatRangeLabel(since, until) };
    }
  }
  const p = COACH_RANGE_PRESETS.find(x => x.key === spec)!;
  return { spec, preset: spec, since, until, label: p.label };
}

/** Resolve a request's range, falling back to the default preset. */
export function resolveRequestRange(spec: unknown): ResolvedBoardRange {
  return resolveBoardRange(normalizeRangeSpec(spec))!;
}

const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatRangeLabel(since: string, until: string): string {
  const [sy, sm, sd] = since.split('-').map(Number);
  const [ey, em, ed] = until.split('-').map(Number);
  if (since === until) return `${M[sm - 1]} ${sd}, ${sy}`;
  return sy === ey ? `${M[sm - 1]} ${sd} – ${M[em - 1]} ${ed}, ${ey}` : `${M[sm - 1]} ${sd}, ${sy} – ${M[em - 1]} ${ed}, ${ey}`;
}
