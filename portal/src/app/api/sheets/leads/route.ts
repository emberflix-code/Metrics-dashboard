import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'GOOGLE_API_KEY not configured' }, { status: 500 });

  // Fetch sheet config for this client
  const rows = await query<{ sheet_id: string; sheet_tab: string }>(
    `SELECT c.sheet_id, c.sheet_tab
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  // Admins can pass ?clientId= to preview any client's sheet
  let sheetId: string;
  let sheetTab: string;

  if (session.user.role === 'admin') {
    const clientId = req.nextUrl.searchParams.get('clientId');
    if (!clientId) return NextResponse.json({ error: 'Missing clientId' }, { status: 400 });
    const [adminRow] = await query<{ sheet_id: string; sheet_tab: string }>(
      'SELECT sheet_id, sheet_tab FROM clients WHERE id = $1',
      [clientId]
    );
    if (!adminRow) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    sheetId = adminRow.sheet_id;
    sheetTab = adminRow.sheet_tab;
  } else {
    const [row] = rows;
    if (!row) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    sheetId = row.sheet_id;
    sheetTab = row.sheet_tab;
  }

  if (!sheetId || !sheetTab) {
    return NextResponse.json({ rows: [], headers: [] });
  }

  const range = encodeURIComponent(sheetTab);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (json.error) {
      return NextResponse.json({ error: json.error.message }, { status: 502 });
    }

    const values: string[][] = json.values ?? [];
    if (values.length === 0) return NextResponse.json({ headers: [], rows: [] });

    const headers = values[0];
    const dataRows = values.slice(1).map(row =>
      Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']))
    );

    return NextResponse.json({ headers, rows: dataRows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
