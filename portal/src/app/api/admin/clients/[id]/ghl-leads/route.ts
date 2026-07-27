import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { fetchGhlLeads, isQualifyingLead, GhlError } from '@/lib/ghl';

// Returns the contact names/emails behind a client's "Leads" count on the
// Agency Overview, for the same [since, until] range and the same
// isQualifyingLead (tag-or-attribution) filter the count itself uses — so
// clicking the number and seeing the list always agree.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const since = sp.get('since') || '';
  const until = sp.get('until') || '';
  if (!since || !until) return NextResponse.json({ error: 'since and until are required' }, { status: 400 });

  const [client] = await query<{ ghl_token_enc: string; ghl_location_id: string; ghl_leads_tag: string }>(
    'SELECT ghl_token_enc, ghl_location_id, ghl_leads_tag FROM clients WHERE id = $1',
    [params.id]
  );
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  if (!client.ghl_token_enc) return NextResponse.json({ error: 'GHL is not configured for this client' }, { status: 400 });

  try {
    const token = decrypt(client.ghl_token_enc);
    const result = await fetchGhlLeads({ token, locationId: client.ghl_location_id });

    const seen = new Set<string>();
    const leads = result.rows
      .filter(r => r.day >= since && r.day <= until && isQualifyingLead(r, client.ghl_leads_tag))
      .filter(r => (seen.has(r.contactId) ? false : (seen.add(r.contactId), true)))
      .map(r => ({ name: r.name || '(no name)', email: r.email, day: r.day }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

    return NextResponse.json({ leads });
  } catch (err) {
    const message = err instanceof GhlError ? err.message : (err instanceof Error ? err.message : 'GHL fetch failed');
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
