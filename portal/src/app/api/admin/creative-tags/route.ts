import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

// Admin-only manual creative tagging (Theme, UGC status) — the dropdowns
// that call this only ever render while an admin is impersonating a client
// (see _isAdminView gating in DashboardClient.tsx), but the route itself
// re-checks role server-side rather than trusting the client not to call it
// directly.
//
// While impersonating, session.user.role is the CLIENT's role ('client'),
// not 'admin' — the original admin identity only survives in
// impersonatedBy (see api/admin/impersonate/route.ts). So the actual gate
// has to accept either a real admin session or an impersonating one.
//
// Partial updates: either field can be omitted/null to leave the other
// unchanged, so the two dropdowns on a creative card can each save
// independently without clobbering the other's current value.

const VALID_THEMES = new Set(['non-active', 'strength', 'tread', 'strength+tread']);
const VALID_UGC_STATUSES = new Set(['ugc', 'non-ugc']);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user.role === 'admin' || !!session?.user.impersonatedBy;
  if (!session || !isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const accountId = String(body?.accountId ?? '').trim();
  const assetKey = String(body?.assetKey ?? '').trim();
  if (!accountId || !assetKey) {
    return NextResponse.json({ error: 'accountId and assetKey are required' }, { status: 400 });
  }

  // Cross-account creative tagging (see EnableCrossAccountCreativeTaggingToggle
  // and DashboardClient.tsx's mergeInto/contributingAccountIds): a merged
  // card can represent the SAME shared-template creative across several of
  // a rollup client's accounts. accountIds, when sent, is every account
  // that card was merged from — the tag applies to each one's own row so
  // it's saved consistently everywhere the creative appears. Falls back to
  // just [accountId] for a normal single-account tag-save (accountIds
  // omitted, or sent by an older client build).
  const rawAccountIds = Array.isArray(body?.accountIds) ? body.accountIds : [];
  const accountIds = Array.from(new Set(
    [accountId, ...rawAccountIds].map(id => String(id ?? '').trim()).filter(Boolean)
  ));

  const existingAssets = await query<{ account_id: string }>(
    'SELECT account_id FROM meta_creative_assets WHERE account_id = ANY($1) AND asset_key = $2',
    [accountIds, assetKey]
  );
  if (existingAssets.length === 0) return NextResponse.json({ error: 'Creative asset not found' }, { status: 404 });
  const foundAccountIds = existingAssets.map(r => r.account_id);

  const hasTheme = Object.prototype.hasOwnProperty.call(body, 'theme');
  const hasUgcStatus = Object.prototype.hasOwnProperty.call(body, 'ugcStatus');

  if (hasTheme) {
    const theme = body.theme === null ? null : String(body.theme).trim();
    if (theme !== null && !VALID_THEMES.has(theme)) {
      return NextResponse.json({ error: `theme must be one of: ${Array.from(VALID_THEMES).join(', ')}, or null to clear` }, { status: 400 });
    }
    await query('UPDATE meta_creative_assets SET theme = $1, updated_at = now() WHERE account_id = ANY($2) AND asset_key = $3', [theme, foundAccountIds, assetKey]);
  }

  if (hasUgcStatus) {
    const ugcStatus = body.ugcStatus === null ? null : String(body.ugcStatus).trim();
    if (ugcStatus !== null && !VALID_UGC_STATUSES.has(ugcStatus)) {
      return NextResponse.json({ error: `ugcStatus must be one of: ${Array.from(VALID_UGC_STATUSES).join(', ')}, or null to clear` }, { status: 400 });
    }
    await query('UPDATE meta_creative_assets SET ugc_status = $1, updated_at = now() WHERE account_id = ANY($2) AND asset_key = $3', [ugcStatus, foundAccountIds, assetKey]);
  }

  return NextResponse.json({ ok: true, appliedToAccountIds: foundAccountIds });
}
