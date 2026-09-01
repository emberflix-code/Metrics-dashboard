import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { getClientDbScope, getAccountTimezone } from '@/lib/meta';
import { decrypt } from '@/lib/crypto';
import { fetchMetaLeads } from '@/lib/metaLeads';

/**
 * The people behind the Leads KPI card, for the same [since, until] the card
 * itself is showing — so opening the modal can never disagree with the number
 * that opened it.
 *
 * Gated three ways, all of which must hold:
 *   1. a logged-in session (the scope helper resolves the caller's own client),
 *   2. clients.show_meta_lead_names — the admin opted this client in,
 *   3. clients.leads_source = 'meta' — a sheet/GHL-sourced count has no Meta
 *      instant form behind it, so there is nothing to enumerate.
 *
 * Account scoping comes from getClientDbScope() (session -> client_users ->
 * clients.ad_account_ids), never from the query string, so one client can
 * never read another client's leads by editing the request.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sp = req.nextUrl.searchParams;
    const since = sp.get('since') || '';
    const until = sp.get('until') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return NextResponse.json({ error: 'since and until (YYYY-MM-DD) are required' }, { status: 400 });
    }

    const [client] = await query<{ show_meta_lead_names: boolean; leads_source: string }>(
      `SELECT c.show_meta_lead_names, c.leads_source
       FROM clients c
       JOIN client_users cu ON cu.client_id = c.id
       WHERE cu.user_id = $1
       LIMIT 1`,
      [session.user.id]
    );
    if (!client?.show_meta_lead_names) {
      return NextResponse.json({ error: 'not_enabled' }, { status: 403 });
    }
    if (client.leads_source !== 'meta') {
      return NextResponse.json({ error: 'not_meta_attribution' }, { status: 403 });
    }

    const { accountIds, campaignFilter } = await getClientDbScope();
    if (accountIds.length === 0) {
      return NextResponse.json({ leads: [], count: 0 });
    }

    // Bucket days in the ad account's timezone, matching how the KPI card and
    // date presets floor their range (see lib/meta.ts getAccountTimezone).
    let timezone = 'UTC';
    const [bmRow] = await query<{ token_enc: string }>(
      `SELECT token_enc FROM agency_bm_connections WHERE $1 && account_ids LIMIT 1`,
      [accountIds]
    );
    if (bmRow) {
      try {
        timezone = await getAccountTimezone(accountIds[0], decrypt(bmRow.token_enc));
      } catch {
        // Fall through to UTC rather than failing the whole request.
      }
    }

    const result = await fetchMetaLeads({ accountIds, campaignFilter, since, until, timezone });
    if (!result.ok) {
      // These are configuration/permission states, not crashes — the client UI
      // shows the message instead of an error toast.
      return NextResponse.json({ error: result.reason, message: result.message }, { status: 200 });
    }

    return NextResponse.json({ leads: result.leads, count: result.leads.length, timezone });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load leads';
    const status = message === 'Unauthorized' ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
