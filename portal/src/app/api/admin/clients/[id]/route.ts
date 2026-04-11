import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { campaign_filter } = await req.json();
  if (campaign_filter === undefined) {
    return NextResponse.json({ error: 'campaign_filter is required' }, { status: 400 });
  }

  const [client] = await query('SELECT id FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  await query('UPDATE clients SET campaign_filter = $1 WHERE id = $2', [campaign_filter.trim(), params.id]);

  return NextResponse.json({ ok: true });
}
