import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { encrypt } from '@/lib/crypto';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { access_token, ad_account_ids, ad_accounts } = await req.json();
  if (!access_token || !ad_account_ids?.length) {
    return NextResponse.json({ error: 'access_token and ad_account_ids are required' }, { status: 400 });
  }

  const normalized: string[] = (ad_account_ids as string[])
    .map((id: string) => id.trim().replace(/^act_/i, ''))
    .filter(Boolean);

  // Store full account objects (id + name) if provided
  const accounts = Array.isArray(ad_accounts) ? ad_accounts : normalized.map((id: string) => ({ id, name: '' }));

  const enc = encrypt(access_token.trim());

  await query(`
    UPDATE agency_settings
    SET meta_token_enc = $1, meta_account_ids = $2, meta_accounts = $3, updated_at = NOW()
    WHERE id = 1
  `, [enc, normalized, JSON.stringify(accounts)]);

  return NextResponse.json({ ok: true });
}
