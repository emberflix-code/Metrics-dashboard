// Resolves an Agency Overview preset/custom date range to a concrete
// [since, until] pair, mirroring Meta Business Manager's picker. Always
// excludes today/future, except for the "today" preset itself (which the
// rest of the app otherwise avoids — the overview surfaces it anyway since
// BM's own picker offers it, matching admin expectations more than the
// stricter client-dashboard convention).

// "This Week" and its Friday/Sunday boundaries use one shared timezone for
// the whole page (not each client's own Meta account timezone) — most of
// this agency's accounts resolve to Eastern anyway, and per-client boundary
// math would mean running the whole spend/leads/bookings pipeline twice per
// client just for this one preset. A shared clock keeps it a single global
// range, same shape as every other preset.
const THIS_WEEK_TIMEZONE = 'America/New_York';

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// Returns the YYYY-MM-DD calendar date "now" in the given IANA timezone.
function todayInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find(p => p.type === 'year')!.value;
  const month = parts.find(p => p.type === 'month')!.value;
  const day = parts.find(p => p.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}

function addDaysToISODate(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return toISODate(date);
}

// getUTCDay() on a date built from Y-M-D at UTC midnight gives the correct
// day-of-week for that calendar date regardless of the caller's own
// timezone — safe here since todayInTimezone() already resolved the
// Y-M-D triple in THIS_WEEK_TIMEZONE before this is called.
function dayOfWeek(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun .. 6=Sat
}

export interface ResolvedRange {
  preset: string;
  since: string;
  until: string;
}

// "This Week" = most recent Friday through yesterday (a rolling window that
// grows through the week), in THIS_WEEK_TIMEZONE. Its comparison range is
// always the FULL prior Friday-Thursday (7 days), regardless of how far
// into the current week "This Week" has progressed — comparing partial
// weeks of different lengths would be misleading, so the comparison is
// always a complete week.
export interface ThisWeekRanges {
  thisWeek: { since: string; until: string };
  comparison: { since: string; until: string };
  // Sunday-Saturday of the CURRENT calendar week (may include future days —
  // intentional, this powers the separate "This Week Bookings" figure,
  // distinct from the Fri-yesterday range used for Leads/Spend/CPL).
  bookingsWeek: { since: string; until: string };
  // The SAME rolling "This Week" window shifted back one day (e.g. This Week
  // Fri-Tue -> this is Fri-Mon) — a day-over-day check on the in-progress
  // week's CPL trend. Null when This Week is only a single day (right after
  // the Friday boundary resets) — there's no earlier day within the same
  // week to compare against yet.
  dayOverDay: { since: string; until: string } | null;
}

export function resolveThisWeekRanges(): ThisWeekRanges {
  const yesterday = addDaysToISODate(todayInTimezone(THIS_WEEK_TIMEZONE), -1);

  // Walk back from yesterday to the most recent Friday (dayOfWeek === 5).
  let mostRecentFriday = yesterday;
  while (dayOfWeek(mostRecentFriday) !== 5) {
    mostRecentFriday = addDaysToISODate(mostRecentFriday, -1);
  }

  const comparisonUntil = addDaysToISODate(mostRecentFriday, -1); // Thursday before this Friday
  const comparisonSince = addDaysToISODate(comparisonUntil, -6);  // Friday, 7 days total

  // Sunday of the current calendar week: walk back from "today" (not
  // yesterday) since the bookings week intentionally includes today/future.
  const todayIso = todayInTimezone(THIS_WEEK_TIMEZONE);
  let sunday = todayIso;
  while (dayOfWeek(sunday) !== 0) {
    sunday = addDaysToISODate(sunday, -1);
  }
  const saturday = addDaysToISODate(sunday, 6);

  const dayBeforeYesterday = addDaysToISODate(yesterday, -1);
  const dayOverDay = dayBeforeYesterday >= mostRecentFriday
    ? { since: mostRecentFriday, until: dayBeforeYesterday }
    : null;

  return {
    thisWeek: { since: mostRecentFriday, until: yesterday },
    comparison: { since: comparisonSince, until: comparisonUntil },
    bookingsWeek: { since: sunday, until: saturday },
    dayOverDay,
  };
}

export function resolveDateRange(searchParams: { preset?: string; since?: string; until?: string }): ResolvedRange {
  // Default view is This Week — matches the default grouping (Marketing
  // Type) as the daily check-in shape most admins land on. Still fully
  // overridable via ?preset=.
  const preset = searchParams.preset || 'this_week';

  if (preset === 'custom' && searchParams.since && searchParams.until) {
    return { preset, since: searchParams.since, until: searchParams.until };
  }

  if (preset === 'this_week') {
    const { thisWeek } = resolveThisWeekRanges();
    return { preset, since: thisWeek.since, until: thisWeek.until };
  }

  if (preset === 'today') {
    const today = toISODate(new Date());
    return { preset, since: today, until: today };
  }

  if (preset === 'yesterday') {
    const y = toISODate(daysAgo(1));
    return { preset, since: y, until: y };
  }

  if (preset === 'this_month') {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const until = toISODate(daysAgo(1));
    return { preset, since: toISODate(first), until };
  }

  if (preset === 'last_month') {
    const now = new Date();
    const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonthEnd = new Date(firstOfThisMonth);
    lastMonthEnd.setUTCDate(lastMonthEnd.getUTCDate() - 1);
    const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
    return { preset, since: toISODate(lastMonthStart), until: toISODate(lastMonthEnd) };
  }

  // Numeric "last N days" presets (7/14/30/90), ending yesterday.
  const days = Math.max(1, Math.min(365, Number(preset) || 30));
  return { preset: String(days), since: toISODate(daysAgo(days)), until: toISODate(daysAgo(1)) };
}
