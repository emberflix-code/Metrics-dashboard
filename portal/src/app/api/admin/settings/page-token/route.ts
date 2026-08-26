import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { encrypt } from '@/lib/crypto';

// Single agency-wide System User token used only for the Page-content image
// fallback (effective_object_story_id -> full_picture) — see 028_page_content_token.sql.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rows = await query<{ token_enc: string | null; updated_at: string }>(
    `SELECT token_enc, updated_at FROM agency_page_token WHERE id = 1`
  );
  return NextResponse.json({ connected: !!rows[0]?.token_enc, updated_at: rows[0]?.updated_at ?? null });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { access_token } = await req.json();
  if (!access_token || typeof access_token !== 'string' || !access_token.trim()) {
    return NextResponse.json({ error: 'access_token is required' }, { status: 400 });
  }

  const enc = encrypt(access_token.trim());
  await query(`UPDATE agency_page_token SET token_enc = $1, updated_at = NOW() WHERE id = 1`, [enc]);

  return NextResponse.json({ ok: true });
}