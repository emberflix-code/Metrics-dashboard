// Prorates a monthly retainer across an arbitrary [since, until] date range
// for the CPA KPI card. A range spanning multiple calendar months is split
// per month, each month contributing (days of the range in that month /
// days in that month) * that month's retainer amount.

export interface RetainerLookup {
  mode: 'flat' | 'monthly';
  flatAmount: number;
  // Keyed by "YYYY-MM". Only consulted when mode === 'monthly'. A month with
  // no entry contributes 0 — it does not fall back to flatAmount, since mixing
  // a client's old flat-rate era with a new monthly-rate era would be wrong
  // more often than it'd be right.
  monthlyAmounts: Record<string, number>;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

function monthKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

export function proratedRetainerForRange(since: string, until: string, lookup: RetainerLookup): number {
  const [sy, sm, sd] = since.split('-').map(Number);
  const [ey, em, ed] = until.split('-').map(Number);
  if (!sy || !sm || !sd || !ey || !em || !ed) return 0;

  let total = 0;
  let year = sy;
  let month0 = sm - 1; // 0-indexed
  while (year < ey || (year === ey && month0 <= em - 1)) {
    const isFirstMonth = year === sy && month0 === sm - 1;
    const isLastMonth = year === ey && month0 === em - 1;
    const rangeStartDay = isFirstMonth ? sd : 1;
    const rangeEndDay = isLastMonth ? ed : daysInMonth(year, month0);
    const daysInRangeThisMonth = rangeEndDay - rangeStartDay + 1;

    const amount = lookup.mode === 'monthly'
      ? (lookup.monthlyAmounts[monthKey(year, month0)] ?? 0)
      : lookup.flatAmount;
    total += (amount / daysInMonth(year, month0)) * daysInRangeThisMonth;

    month0++;
    if (month0 > 11) { month0 = 0; year++; }
  }
  return total;
}
