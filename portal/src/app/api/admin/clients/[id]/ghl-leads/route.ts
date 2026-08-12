import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { fetchGhlLeads, dayInTimezone, isQualifyingLead, BOOKING_TAG, GhlError } from '@/lib/ghl';
import { getAdminClientMetaScope, getAccountTimezone } from '@/lib/meta';

interface BmConnectionRow {
  token_enc: string;
  account_ids: string[];
}

// Returns the contact names/emails behind a client's "Leads" count on the
// Agency Overview, for the same [since, until] range and the same
// isQualifyingLead (tag-or-attribution) filter the count itself uses — so
// clicking the number and seeing the list always agree. Days are bucketed
// using the client's own Meta ad account timezone (see lib/meta.ts
// getAccountTimezone), matching the count's own bucketing.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const since = sp.get('since') || '';
  const until = sp.get('until') || '';
  if (!since || !until) return NextResponse.json({ error: 'since and until are required' }, { status: 400 });

  const [client] = await query<{
    ghl_token_enc: string;
    ghl_location_id: string;
    ghl_leads_tag: string;
    ad_account_ids: string[] | null;
    campaign_filter: string;
  }>(
    'SELECT ghl_token_enc, ghl_location_id, ghl_leads_tag, ad_account_ids, campaign_filter FROM clients WHERE id = $1',
    [params.id]
  );
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  if (!client.ghl_token_enc) return NextResponse.json({ error: 'GHL is not configured for this client' }, { status: 400 });

  try {
    const token = decrypt(client.ghl_token_enc);
    const result = await fetchGhlLeads({ token, locationId: client.ghl_location_id });

    const bmRows = await query<BmConnectionRow>(`SELECT token_enc, account_ids FROM agency_bm_connections`);
    const agencyAccountIds = Array.from(new Set(bmRows.flatMap(r => r.account_ids || [])));
    const tokenByAccountId = new Map<string, string>();
    for (const bm of bmRows) {
      for (const accId of bm.account_ids || []) {
        if (!tokenByAccountId.has(accId)) tokenByAccountId.set(accId, bm.token_enc);
      }
    }
    const scope = await getAdminClientMetaScope({ ad_account_ids: client.ad_account_ids, campaign_filter: client.campaign_filter }, agencyAccountIds);
    let timezone = 'UTC';
    const accountId = scope.accountIds[0];
    const metaTokenEnc = accountId ? tokenByAccountId.get(accountId) : undefined;
    if (accountId && metaTokenEnc) {
      timezone = await getAccountTimezone(accountId, decrypt(metaTokenEnc));
    }

    const bookingTag = BOOKING_TAG.toLowerCase();
    const seen = new Set<string>();
    const leads = result.rows
      .map(r => ({ ...r, day: dayInTimezone(r.date, timezone) }))
      .filter(r => r.day >= since && r.day <= until && isQualifyingLead(r, client.ghl_leads_tag))
      .filter(r => (seen.has(r.contactId) ? false : (seen.add(r.contactId), true)))
      .map(r => ({
        name: r.name || '(no name)',
        email: r.email,
        day: r.day,
        booked: r.tags.some(t => t.toLowerCase() === bookingTag),
      }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

    return NextResponse.json({ leads });
  } catch (err) {
    const message = err instanceof GhlError ? err.message : (err instanceof Error ? err.message : 'GHL fetch failed');
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
