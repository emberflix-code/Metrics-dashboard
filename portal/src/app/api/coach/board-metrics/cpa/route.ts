import { NextRequest, NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { loadCoachClients } from '@/lib/coach/scope';
import { computeBoardMetrics } from '@/lib/coach/metrics';
import { RANGE_KEYS } from '@/lib/coach/columns';
import { resolveDateRange } from '@/lib/dateRange';
import { query } from '@/lib/db';
import { fetchAcquisitionRows } from '@/lib/acquisitionSheet';
import { proratedRetainerForRange } from '@/lib/retainer';
import { matchesCampaignFilter } from '@/lib/meta';

// Won Sales / CPA / LTV board columns — computed exactly like the client
// dashboard's CPA and LTV cards: won rows on the client's CPA sheet tab in
// the range; CPA = (Meta spend + retainer prorated over months that had this
// client's own spend) ÷ won; LTV = won × ltv_value. Needs a Google Sheet
// fetch per client, so it's opt-in and separate from the cached metrics.
// Requested ids are intersected with the session's own scope; 4 at a time.
const CONCURRENCY = 4;

interface CpaConfig {
  id: string; cpa_sheet_id: string; cpa_sheet_tab: string; retainer_mode: 'flat' | 'monthly';
  retainer_flat_amount: string; ltv_value: string; ad_account_ids: string[] | null; campaign_filter: string;
}

export async function POST(req: NextRequest) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  const body = await req.json().catch(() => ({}));
  const preset = RANGE_KEYS.includes(String(body.range)) ? String(body.range) : '7';
  const { since, until } = resolveDateRange({ preset }, '7');
  const requested = new Set<string>(Array.isArray(body.clientIds) ? body.clientIds.map(String) : []);

  const scoped = (await loadCoachClients(ctx)).filter(c => requested.has(c.id) && c.cpaEnabled).slice(0, 60);
  if (!scoped.length) return NextResponse.json({ rows: {} });
  const ids = scoped.map(c => c.id);

  const [configs, retainers, spendRows] = await Promise.all([
    query<CpaConfig>(
      `SELECT id, cpa_sheet_id, cpa_sheet_tab, retainer_mode, retainer_flat_amount, ltv_value, ad_account_ids, campaign_filter
       FROM clients WHERE id = ANY($1)`, [ids]),
    query<{ client_id: string; month: string; amount: string }>(
      `SELECT client_id, to_char(month, 'YYYY-MM') AS month, amount FROM client_retainers WHERE client_id = ANY($1)`, [ids]),
    computeBoardMetrics(scoped, ['spend'], since, until),
  ]);
  // Months in range with this client's own Meta spend (retainer is only charged for those).
  const accountIds = Array.from(new Set(configs.flatMap(c => c.ad_account_ids || [])));
  const monthRows = accountIds.length ? await query<{ month: string; account_id: string; campaign_name: string }>(
    `SELECT DISTINCT to_char(date, 'YYYY-MM') AS month, account_id, campaign_name FROM meta_daily_insights
     WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3 AND spend > 0`,
    [accountIds, since, until]) : [];

  const rows: Record<string, { won: number; cpa: number | null; ltv: number | null; cpa_cost: number } | { error: string }> = {};
  let next = 0;
  async function worker() {
    while (next < configs.length) {
      const c = configs[next++];
      const client = scoped.find(s => s.id === c.id)!;
      try {
        const { rows: acq } = await fetchAcquisitionRows(c.cpa_sheet_id, c.cpa_sheet_tab);
        const won = acq.filter(r => r.won && r.day >= since && r.day <= until).length;
        const monthsWithSpend: Record<string, boolean> = {};
        for (const r of monthRows) {
          if ((c.ad_account_ids || []).includes(r.account_id) && matchesCampaignFilter(r.campaign_name, c.campaign_filter, r.account_id)) monthsWithSpend[r.month] = true;
        }
        const retainer = proratedRetainerForRange(since, until, {
          mode: c.retainer_mode,
          flatAmount: Number(c.retainer_flat_amount),
          monthlyAmounts: Object.fromEntries(retainers.filter(r => r.client_id === c.id).map(r => [r.month, Number(r.amount)])),
          monthsWithSpend,
        });
        const spend = Number(spendRows[c.id]?.spend) || 0;
        rows[c.id] = {
          won,
          cpa: won > 0 ? Math.round(((spend + retainer) / won) * 100) / 100 : null,
          ltv: client.ltvEnabled ? Math.round(won * Number(c.ltv_value) * 100) / 100 : null,
          // spend + retainer, so the board's group total can show a true blended CPA
          cpa_cost: Math.round((spend + retainer) * 100) / 100,
        };
      } catch (err) {
        rows[c.id] = { error: err instanceof Error ? err.message : 'CPA sheet fetch failed' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, configs.length) }, worker));
  return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store' } });
}
