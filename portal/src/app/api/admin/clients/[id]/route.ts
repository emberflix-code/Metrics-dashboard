import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();

  const [client] = await query('SELECT id FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  if (body.campaign_filter !== undefined) {
    await query('UPDATE clients SET campaign_filter = $1 WHERE id = $2', [body.campaign_filter.trim(), params.id]);
  }

  if (body.ad_account_ids !== undefined) {
    if (!Array.isArray(body.ad_account_ids)) {
      return NextResponse.json({ error: 'ad_account_ids must be an array' }, { status: 400 });
    }
    await query('UPDATE clients SET ad_account_ids = $1 WHERE id = $2', [body.ad_account_ids, params.id]);
  }

  if (body.show_account !== undefined) {
    await query('UPDATE clients SET show_account = $1 WHERE id = $2', [!!body.show_account, params.id]);
  }

  return NextResponse.json({ ok: true });
}
