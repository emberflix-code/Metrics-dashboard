import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { parseAssetLibraryParams, queryAssetLibrary } from '@/lib/marketer/assetLibrary';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

// Paged cross-account asset library (creatives + copy variants). Every
// filter/sort lives in the query string so the client component can mirror
// it 1:1 into the page URL; see parseAssetLibraryParams for the vocabulary.
export async function GET(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();

  const sp = req.nextUrl.searchParams;
  const range = resolveDateRange({ preset: sp.get('preset') ?? undefined, since: sp.get('since') ?? undefined, until: sp.get('until') ?? undefined }, '30');
  const q = parseAssetLibraryParams(sp, range);

  const result = await queryAssetLibrary(q);
  return NextResponse.json({
    rows: result.rows,
    total: result.total,
    page: q.page,
    pageSize: q.pageSize,
    range,
    totals: result.totals,
  }, NO_STORE);
}
