import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

interface ClientConfig {
  sheet_id: string;
  google_sheet_tab: string;
}

interface GoogleRow {
  campaign: string;
  day: string;          // ISO YYYY-MM-DD
  spend: number;
  leads: number;
  impressions: number;
  linkClicks: number;
}

/** "12/4/2025", "2025-12-04", "12/04/25" → ISO YYYY-MM-DD; null if unparseable. */
function normalizeDay(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (mdy) {
    const m = mdy[1].padStart(2, '0');
    const d = mdy[2].padStart(2, '0');
    let y = mdy[3];
    if (y.length === 2) y = (parseInt(y, 10) >= 70 ? '19' : '20') + y;
    return `${y}-${m}-${d}`;
  }
  return null;
}

/** "$45.69" → 45.69; "1.21%" → 1.21; "—", "#DIV/0!" → 0. */
function parseNum(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[$,%\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'GOOGLE_API_KEY not configured' }, { status: 500 });

  const [client] = await query<ClientConfig>(
    `SELECT c.sheet_id, c.google_sheet_tab
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  if (!client?.sheet_id || !client?.google_sheet_tab) {
    return NextResponse.json({ rows: [] });
  }

  const range = encodeURIComponent(client.google_sheet_tab);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${client.sheet_id}/values/${range}?key=${apiKey}`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) return NextResponse.json({ error: json.error.message }, { status: 502 });

    const values: string[][] = json.values ?? [];
    if (values.length < 2) return NextResponse.json({ rows: [] });

    // Map header names to column indices so column order is robust.
    const headers = values[0].map(h => (h || '').trim().toLowerCase());
    const idx = (name: string) => headers.findIndex(h => h === name);
    const cCampaign = idx('campaign name');
    const cSpend = idx('amount spent');
    const cLeads = idx('leads');
    const cImpressions = idx('impressions');
    const cLinkClicks = headers.findIndex(h => h.startsWith('link clicks'));
    const cDay = idx('day');

    if (cCampaign < 0 || cDay < 0) {
      return NextResponse.json({ error: `Sheet tab "${client.google_sheet_tab}" is missing required columns (Campaign Name, Day).` }, { status: 502 });
    }

    const rows: GoogleRow[] = [];
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      const campaign = (r[cCampaign] || '').trim();
      const day = normalizeDay(r[cDay] || '');
      if (!campaign || !day) continue;
      rows.push({
        campaign,
        day,
        spend: parseNum(r[cSpend] ?? ''),
        leads: Math.round(parseNum(r[cLeads] ?? '')),
        impressions: Math.round(parseNum(r[cImpressions] ?? '')),
        linkClicks: Math.round(parseNum(r[cLinkClicks] ?? '')),
      });
    }

    return NextResponse.json({ rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
