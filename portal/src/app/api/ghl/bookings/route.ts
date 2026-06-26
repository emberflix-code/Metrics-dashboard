import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { fetchGhlBookings, GhlError } from '@/lib/ghl';

// Returns booked-contact attribution rows from GHL, optionally clipped to
// [since, until]. Powers both the optional 7th "Bookings" KPI card AND the
// "Leads from GHL" override of the existing Leads card when the admin has
// set `leads_source = 'ghl'`.
//
// Response never contains the decrypted token. Errors map to clear,
// actionable admin-facing messages (regenerate token, fix scope, wait
// on rate limit).

interface ClientConfig {
  ghl_token_enc: string;
  ghl_location_id: string;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get('since') ?? '';
  const until = url.searchParams.get('until') ?? '';

  const [client] = await query<ClientConfig>(
    `SELECT c.ghl_token_enc, c.ghl_location_id
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  if (!client?.ghl_token_enc) {
    return NextResponse.json({ rows: [], enabled: false });
  }

  let token: string;
  try {
    token = decrypt(client.ghl_token_enc);
  } catch {
    return NextResponse.json({ error: 'Stored GHL token could not be decrypted.', enabled: true }, { status: 500 });
  }

  try {
    const result = await fetchGhlBookings({ token, locationId: client.ghl_location_id || undefined });
    // Clip to [since, until] if provided. Strings sort YYYY-MM-DD correctly.
    const rows = (since && until)
      ? result.rows.filter(r => r.day >= since && r.day <= until)
      : result.rows;
    return NextResponse.json({
      rows,
      enabled: true,
      bookedContactsScanned: result.bookedContactsScanned,
      outsideWindow: result.outsideWindow,
      cancelledContacts: result.cancelledContacts,
    });
  } catch (err) {
    if (err instanceof GhlError) {
      return NextResponse.json({ error: err.message, code: err.code, enabled: true }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, enabled: true }, { status: 500 });
  }
}
