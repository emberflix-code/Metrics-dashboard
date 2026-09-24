import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { parseAssetLibraryParams, queryAssetLibrary, type AssetLibraryRow } from '@/lib/marketer/assetLibrary';

// CSV of the same filtered/sorted set the table shows, one page of up to
// 5,000 rows — enough for any single account's creatives in a range, and a
// hard cap so a bookmarked export can't turn into a full-table dump.
const EXPORT_CAP = 5000;

const COLUMNS = [
  'key', 'type', 'theme', 'ugc', 'spend', 'results', 'cpl', 'ctr', 'cpm', 'impressions', 'reach', 'link_clicks',
  'ads', 'active_ads', 'campaigns', 'clients', 'offers', 'accounts', 'first_date', 'last_date',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Quote anything with a delimiter, quote, or newline; double inner quotes.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowToCsv(r: AssetLibraryRow): string {
  const cells: unknown[] = [
    r.kind === 'creative' ? r.key : (r.text ?? r.key),
    r.type ?? '',
    r.theme ?? '',
    r.ugcStatus ?? '',
    r.spend.toFixed(2),
    r.results,
    r.cpl === null ? '' : r.cpl.toFixed(2),
    r.ctr === null ? '' : r.ctr.toFixed(2),
    r.cpm === null ? '' : r.cpm.toFixed(2),
    r.impressions,
    r.reach ?? '',
    r.linkClicks,
    r.adCount,
    r.activeAdCount,
    r.campaignCount,
    r.clientCount,
    r.offers.join('|'),
    r.accountIds.join('|'),
    r.firstDate,
    r.lastDate,
  ];
  return cells.map(csvCell).join(',');
}

export async function GET(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();

  const sp = req.nextUrl.searchParams;
  const range = resolveDateRange({ preset: sp.get('preset') ?? undefined, since: sp.get('since') ?? undefined, until: sp.get('until') ?? undefined }, '30');
  const q = parseAssetLibraryParams(sp, range, { pageSize: EXPORT_CAP });
  q.page = 1;

  const result = await queryAssetLibrary(q);
  const header = COLUMNS.map(c => (c === 'key' && q.kind !== 'creative' ? 'text' : c)).join(',');
  const body = [header, ...result.rows.map(rowToCsv)].join('\r\n') + '\r\n';

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="assets-${q.kind}-${range.since}-${range.until}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
