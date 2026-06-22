import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

// Mirror of /api/sheets/google, but reads the client's `sheet_tab` (Meta-side
// tab) instead of `google_sheet_tab`. Used by the Meta dashboard when the
// client has `use_sheet_for_leads=true` so the KPI lead total reflects the
// canonical sheet count rather than Meta's pixel events.

interface ClientConfig {
  sheet_id: string;
  sheet_tab: string;
  use_sheet_for_leads: boolean;
}

interface MetaSheetRow {
  campaign: string;
  day: string;
  spend: number;
  leads: number;
  impressions: number;
  linkClicks: number;
}

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

function parseNum(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[$,%\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

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

const TTL_MS = 60_000;
const _csvCache = new Map<string, { expires: number; rows: MetaSheetRow[] }>();

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [client] = await query<ClientConfig>(
    `SELECT c.sheet_id, c.sheet_tab, c.use_sheet_for_leads
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  // Gate: only return rows when the admin has explicitly opted this client in.
  // Without the gate, every client with a `sheet_tab` populated would silently
  // switch lead sources the moment they loaded the dashboard.
  if (!client?.use_sheet_for_leads || !client?.sheet_id || !client?.sheet_tab) {
    return NextResponse.json({ rows: [], enabled: false });
  }

  const cacheKey = `${client.sheet_id}|${client.sheet_tab}`;
  const hit = _csvCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return NextResponse.json({ rows: hit.rows, enabled: true });
  }

  const url = `https://docs.google.com/spreadsheets/d/${client.sheet_id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(client.sheet_tab)}`;

  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return NextResponse.json({ error: `Sheet fetch failed: ${res.status}`, enabled: true }, { status: 502 });
    const csv = await res.text();
    if (csv.trim().startsWith('<')) {
      return NextResponse.json({ error: 'Sheet is not publicly viewable. Set sharing to "Anyone with the link".', enabled: true }, { status: 502 });
    }

    const values = parseCsv(csv);
    if (values.length < 2) return NextResponse.json({ rows: [], enabled: true });

    const headers = values[0].map(h => (h || '').trim().toLowerCase());
    const idx = (name: string) => headers.findIndex(h => h === name);
    const cCampaign = idx('campaign name');
    const cSpend = idx('amount spent');
    const cLeads = idx('leads');
    const cImpressions = idx('impressions');
    const cLinkClicks = headers.findIndex(h => h.startsWith('link clicks'));
    const cDay = idx('day');

    if (cCampaign < 0 || cDay < 0) {
      return NextResponse.json({ error: `Sheet tab "${client.sheet_tab}" is missing required columns (Campaign Name, Day).`, enabled: true }, { status: 502 });
    }

    const rows: MetaSheetRow[] = [];
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
    return NextResponse.json({ rows, enabled: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, enabled: true }, { status: 500 });
  }
}
