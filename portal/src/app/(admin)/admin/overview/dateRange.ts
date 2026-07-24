// Resolves an Agency Overview preset/custom date range to a concrete
// [since, until] pair, mirroring Meta Business Manager's picker. Always
// excludes today/future, except for the "today" preset itself (which the
// rest of the app otherwise avoids — the overview surfaces it anyway since
// BM's own picker offers it, matching admin expectations more than the
// stricter client-dashboard convention).

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

export interface ResolvedRange {
  preset: string;
  since: string;
  until: string;
}

export function resolveDateRange(searchParams: { preset?: string; since?: string; until?: string }): ResolvedRange {
  const preset = searchParams.preset || '30';

  if (preset === 'custom' && searchParams.since && searchParams.until) {
    return { preset, since: searchParams.since, until: searchParams.until };
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
