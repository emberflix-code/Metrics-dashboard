import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { getChatgptAdImage } from '@/lib/chatgptAds';

// Stored creative image of one ChatGPT ad, only for the signed-in client's own
// ChatGPT ad account.
export async function GET(_req: Request, { params }: { params: { adId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });
  const { adId } = params;

  const [client] = await query<{ chatgpt_ads_account_id: string }>(
    `SELECT c.chatgpt_ads_account_id FROM clients c JOIN client_users cu ON cu.client_id = c.id WHERE cu.user_id = $1 LIMIT 1`,
    [session.user.id]
  );
  if (!client?.chatgpt_ads_account_id) return new NextResponse('Not found', { status: 404 });

  const img = await getChatgptAdImage(client.chatgpt_ads_account_id, adId);
  if (!img) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(new Uint8Array(img.bytes), {
    headers: { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=3600' },
  });
}
