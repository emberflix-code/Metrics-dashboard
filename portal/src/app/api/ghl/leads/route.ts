import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { fetchGhlLeads, fetchGhlFormSubmissions, dayInTimezone, isQualifyingLead, BOOKING_TAG, GhlError } from '@/lib/ghl';
import { getClientConnection, getAccountTimezone } from '@/lib/meta';

// The leads behind the client dashboard's "Leads" card when the admin set
// `leads_source = 'ghl'` — one row per qualifying GHL contact in [since, until].
// Same rule as the Agency Overview's Leads column (and its admin-only
// /api/admin/clients/[id]/ghl-leads list): isQualifyingLead (Leads Tag, or an
// attributed campaign when no tag is set), dated by dateAdded, plus any dated
// form submission inside the range for a contact created earlier — so the
// card, this list and the Overview always agree.
//
// Scoped to the signed-in client's own GHL location, like /api/ghl/bookings.
// Response never contains the decrypted token.

interface ClientConfig {
  ghl_token_enc: string;
  ghl_location_id: string;
  ghl_leads_tag: string;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get('since') ?? '';
  const until = url.searchParams.get('until') ?? '';
  if (!since || !until) return NextResponse.json({ error: 'since and until are required', enabled: true }, { status: 400 });

  const [client] = await query<ClientConfig>(
    `SELECT c.ghl_token_enc, c.ghl_location_id, c.ghl_leads_tag
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  if (!client?.ghl_token_enc) {
    return NextResponse.json({ leads: [], enabled: false });
  }

  let token: string;
  try {
    token = decrypt(client.ghl_token_enc);
  } catch {
    return NextResponse.json({ error: 'Stored GHL token could not be decrypted.', enabled: true }, { status: 500 });
  }

  try {
    const [result, submissionsResult] = await Promise.all([
      fetchGhlLeads({ token, locationId: client.ghl_location_id || undefined }),
      fetchGhlFormSubmissions({ token, locationId: client.ghl_location_id || undefined }),
    ]);

    // Bucket by the client's own Meta ad account timezone — see the matching
    // comment in /api/ghl/bookings.
    let timezone = 'UTC';
    try {
      const conn = await getClientConnection();
      if (conn.accountIds.length > 0) {
        const accountId = conn.accountIds[0];
        timezone = await getAccountTimezone(accountId, conn.tokenForAccount(accountId));
      }
    } catch {
      // No Meta connection configured for this client — fall back to UTC.
    }

    const leadsTag = client.ghl_leads_tag || '';
    const bookingTag = BOOKING_TAG.toLowerCase();
    const byContactId = new Map(result.rows.map(r => [r.contactId, r] as const));
    const seen = new Set<string>();
    const leads: { contactId: string; name: string; email: string; phone: string; day: string; tags: string[]; booked: boolean }[] = [];
    const push = (contact: (typeof result.rows)[number], day: string) => {
      seen.add(contact.contactId);
      leads.push({
        contactId: contact.contactId,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        day,
        tags: contact.tags,
        booked: contact.tags.some(t => t.toLowerCase() === bookingTag),
      });
    };

    for (const r of result.rows) {
      if (seen.has(r.contactId) || !isQualifyingLead(r, leadsTag)) continue;
      const day = dayInTimezone(r.date, timezone);
      if (day < since || day > until) continue;
      push(r, day);
    }
    for (const s of submissionsResult.rows) {
      if (seen.has(s.contactId)) continue;
      const contact = byContactId.get(s.contactId);
      if (!contact || !isQualifyingLead(contact, leadsTag)) continue;
      const day = dayInTimezone(s.date, timezone);
      if (day < since || day > until) continue;
      push(contact, day);
    }
    leads.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

    return NextResponse.json({ leads, enabled: true });
  } catch (err) {
    if (err instanceof GhlError) {
      return NextResponse.json({ error: err.message, code: err.code, enabled: true }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, enabled: true }, { status: 500 });
  }
}
