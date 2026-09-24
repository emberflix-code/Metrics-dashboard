import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { ASSET_KINDS, getAssetDetail, type AssetKind } from '@/lib/marketer/assetLibrary';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

// Drill-down for one asset (creative asset_key or copy text hash) — feeds
// the AssetDetailDrawer. `key` arrives URL-encoded because asset keys carry
// a colon ("image:<hash>").
export async function GET(req: NextRequest, { params }: { params: { kind: string; key: string } }) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();

  const kind = params.kind as AssetKind;
  if (!ASSET_KINDS.includes(kind)) return NextResponse.json({ error: 'Unknown kind' }, { status: 400, ...NO_STORE });
  let key: string;
  try { key = decodeURIComponent(params.key); } catch { return NextResponse.json({ error: 'Bad key' }, { status: 400, ...NO_STORE }); }
  if (!key) return NextResponse.json({ error: 'Bad key' }, { status: 400, ...NO_STORE });

  const sp = req.nextUrl.searchParams;
  const range = resolveDateRange({ preset: sp.get('preset') ?? undefined, since: sp.get('since') ?? undefined, until: sp.get('until') ?? undefined }, '30');

  const inactive = sp.get('inactive');
  const detail = await getAssetDetail(kind, key, range.since, range.until, { includeInactive: inactive === '1' || inactive === 'true' });
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404, ...NO_STORE });
  return NextResponse.json({ ...detail, range }, NO_STORE);
}
