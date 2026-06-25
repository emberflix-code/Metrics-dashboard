import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { encrypt } from '@/lib/crypto';

interface ListedConnection {
  id: string;
  label: string;
  account_ids: string[];
  accounts_json: { id: string; name?: string }[];
  sort_order: number;
}

// GET: list all BM connections. Tokens are never returned — only metadata.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rows = await query<ListedConnection>(
    `SELECT id, label, account_ids, accounts_json, sort_order
     FROM agency_bm_connections
     ORDER BY sort_order ASC, created_at ASC`
  );
  return NextResponse.json({ connections: rows });
}

// POST: create a new BM connection. Body: { label, access_token, ad_account_ids[], ad_accounts[] }.
// The token gets encrypted; the same shape mirrors the legacy /admin/settings/meta endpoint.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { label, access_token, ad_account_ids, ad_accounts } = await req.json();
  if (!label?.trim()) return NextResponse.json({ error: 'label is required' }, { status: 400 });
  if (!access_token?.trim()) return NextResponse.json({ error: 'access_token is required' }, { status: 400 });

  const normalized: string[] = Array.isArray(ad_account_ids)
    ? (ad_account_ids as string[]).map(id => id.trim().replace(/^act_/i, '')).filter(Boolean)
    : [];
  const accounts = Array.isArray(ad_accounts) ? ad_accounts : normalized.map(id => ({ id, name: '' }));
  const enc = encrypt(access_token.trim());

  // Append to the end of the sort order so it shows after existing rows.
  const [{ next_order }] = await query<{ next_order: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM agency_bm_connections`
  );

  try {
    const [row] = await query<{ id: string }>(
      `INSERT INTO agency_bm_connections (label, token_enc, account_ids, accounts_json, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [label.trim(), enc, normalized, JSON.stringify(accounts), next_order]
    );
    return NextResponse.json({ ok: true, id: row.id });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      return NextResponse.json({ error: `A connection labeled "${label.trim()}" already exists. Pick a different label.` }, { status: 409 });
    }
    throw err;
  }
}
