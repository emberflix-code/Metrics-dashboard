import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { encrypt } from '@/lib/crypto';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.label !== undefined) {
    updates.push(`label = $${updates.length + 1}`);
    values.push(String(body.label).trim());
  }
  if (body.access_token !== undefined && String(body.access_token).trim()) {
    updates.push(`token_enc = $${updates.length + 1}`);
    values.push(encrypt(String(body.access_token).trim()));
  }
  if (body.ad_account_ids !== undefined) {
    const normalized: string[] = Array.isArray(body.ad_account_ids)
      ? (body.ad_account_ids as string[]).map(id => id.trim().replace(/^act_/i, '')).filter(Boolean)
      : [];
    updates.push(`account_ids = $${updates.length + 1}`);
    values.push(normalized);
  }
  if (body.ad_accounts !== undefined) {
    updates.push(`accounts_json = $${updates.length + 1}`);
    values.push(JSON.stringify(body.ad_accounts || []));
  }

  if (updates.length === 0) return NextResponse.json({ ok: true });
  updates.push(`updated_at = NOW()`);
  values.push(params.id);

  try {
    await query(
      `UPDATE agency_bm_connections SET ${updates.join(', ')} WHERE id = $${values.length}`,
      values
    );
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      return NextResponse.json({ error: 'Another connection already uses that label. Pick a different one.' }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Guard: refuse to delete the last connection (would brick the dashboard).
  const [{ count }] = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM agency_bm_connections`);
  if (parseInt(count, 10) <= 1) {
    return NextResponse.json({ error: 'Cannot delete the last BM connection' }, { status: 400 });
  }
  await query(`DELETE FROM agency_bm_connections WHERE id = $1`, [params.id]);
  return NextResponse.json({ ok: true });
}
