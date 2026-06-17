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

/** Minimal CSV parser supporting quoted fields and embedded commas/newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else { cell += c; }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

// 60s in-memory cache keyed by sheet_id + tab name. Lets multiple loads in a
// short window skip the upstream fetch.
const TTL_MS = 60_000;
const _csvCache = new Map<string, { expires: number; rows: GoogleRow[] }>();

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  const cacheKey = `${client.sheet_id}|${client.google_sheet_tab}`;
  const hit = _csvCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return NextResponse.json({ rows: hit.rows });
  }

  // Public-link CSV export — no GCP / API key required.
  // gviz/tq?sheet=<tab name> picks the tab by name, no gid needed.
  const url = `https://docs.google.com/spreadsheets/d/${client.sheet_id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(client.google_sheet_tab)}`;

  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return NextResponse.json({ error: `Sheet fetch failed: ${res.status}` }, { status: 502 });
    const csv = await res.text();
    // If the sheet's privacy changes from public, Google returns an HTML login page.
    if (csv.trim().startsWith('<')) {
      return NextResponse.json({ error: 'Sheet is not publicly viewable. Set sharing to "Anyone with the link".' }, { status: 502 });
    }

    const values = parseCsv(csv);
    if (values.length < 2) return NextResponse.json({ rows: [] });

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

    _csvCache.set(cacheKey, { expires: Date.now() + TTL_MS, rows });
    return NextResponse.json({ rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
