import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { getAdminClientMetaScope, matchesCampaignFilter } from '@/lib/meta';
import { fetchGhlLeads, fetchGhlBookings, GhlError } from '@/lib/ghl';
import ActiveToggle from '../clients/[id]/ActiveToggle';
import OverviewRangeSelect from './OverviewRangeSelect';

interface ClientRow {
  id: string;
  name: string;
  email: string;
  ad_account_ids: string[] | null;
  campaign_filter: string;
  data_source: 'live' | 'cached';
  leads_source: 'meta' | 'sheet' | 'ghl';
  has_ghl_token: boolean;
  ghl_token_enc: string;
  ghl_location_id: string;
  active: boolean;
}

interface BmConnectionRow {
  token_enc: string;
  account_ids: string[];
}

interface RowResult {
  client: ClientRow;
  leads: number | null;       // null = not configured
  bookings: number | null;    // null = not configured
  spend: number;
  cpl: number | null;
  ghlError: string | null;
  metaError: string | null;
}

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export default async function OverviewPage({ searchParams }: { searchParams: { days?: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  const days = Math.max(1, Math.min(365, Number(searchParams.days) || 30));
  // Excludes today, consistent with the rest of the app's date handling.
  const until = dateNDaysAgo(1);
  const since = dateNDaysAgo(days);

  const clients = await query<ClientRow>(`
    SELECT c.id, c.name, u.email, c.ad_account_ids, c.campaign_filter,
           c.data_source, c.leads_source,
           (length(c.ghl_token_enc) > 0) AS has_ghl_token,
           c.ghl_token_enc, c.ghl_location_id, c.active
    FROM clients c
    JOIN client_users cu ON cu.client_id = c.id
    JOIN users u ON u.id = cu.user_id
    WHERE c.active = true
    ORDER BY c.name ASC
  `);

  const bmRows = await query<BmConnectionRow>(`SELECT token_enc, account_ids FROM agency_bm_connections`);
  const agencyAccountIds = Array.from(new Set(bmRows.flatMap(r => r.account_ids || [])));
  const tokenByAccountId = new Map<string, string>();
  for (const bm of bmRows) {
    for (const accId of bm.account_ids || []) {
      if (!tokenByAccountId.has(accId)) tokenByAccountId.set(accId, bm.token_enc);
    }
  }

  // Resolve each client's scope (accountIds + campaignFilter) up front.
  const scopes = await Promise.all(
    clients.map(c => getAdminClientMetaScope({ ad_account_ids: c.ad_account_ids, campaign_filter: c.campaign_filter }, agencyAccountIds))
  );

  // --- Spend: split by data_source, dedupe by unique account_id ---
  const cachedAccountIds = new Set<string>();
  const liveAccountIds = new Set<string>();
  clients.forEach((c, i) => {
    for (const accId of scopes[i].accountIds) {
      if (c.data_source === 'cached') cachedAccountIds.add(accId);
      else liveAccountIds.add(accId);
    }
  });

  // Cached accounts: one batched query across every unique cached account_id.
  const campaignRowsByAccount = new Map<string, { campaign_name: string; spend: number }[]>();
  if (cachedAccountIds.size > 0) {
    const rows = await query<{ account_id: string; campaign_name: string; spend: string }>(
      `SELECT account_id, campaign_name, SUM(spend)::text AS spend
       FROM meta_daily_insights
       WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3
       GROUP BY account_id, campaign_name`,
      [Array.from(cachedAccountIds), since, until]
    );
    for (const r of rows) {
      const list = campaignRowsByAccount.get(r.account_id) || [];
      list.push({ campaign_name: r.campaign_name || '', spend: parseFloat(r.spend) || 0 });
      campaignRowsByAccount.set(r.account_id, list);
    }
  }

  // Live accounts: one Graph API call per unique account, in parallel.
  const liveAccountError = new Map<string, string>();
  const liveResults = await Promise.all(
    Array.from(liveAccountIds).map(async accId => {
      const tokenEnc = tokenByAccountId.get(accId);
      if (!tokenEnc) { liveAccountError.set(accId, 'No Meta connection for this account'); return { accId, rows: [] as { campaign_name: string; spend: number }[] }; }
      try {
        const token = decrypt(tokenEnc);
        const url = new URL(`https://graph.facebook.com/v22.0/act_${accId}/insights`);
        url.searchParams.set('fields', 'campaign_name,spend');
        url.searchParams.set('level', 'campaign');
        url.searchParams.set('time_range', JSON.stringify({ since, until }));
        url.searchParams.set('limit', '500');
        url.searchParams.set('access_token', token);
        const res = await fetch(url.toString());
        const json = await res.json();
        if (!res.ok) { liveAccountError.set(accId, json?.error?.message || `Meta API error ${res.status}`); return { accId, rows: [] }; }
        const rows = (json.data || []).map((d: { campaign_name?: string; spend?: string }) => ({
          campaign_name: d.campaign_name || '',
          spend: parseFloat(d.spend || '0') || 0,
        }));
        return { accId, rows };
      } catch (err) {
        liveAccountError.set(accId, err instanceof Error ? err.message : 'Meta fetch failed');
        return { accId, rows: [] as { campaign_name: string; spend: number }[] };
      }
    })
  );
  for (const { accId, rows } of liveResults) campaignRowsByAccount.set(accId, rows);

  function spendForClient(accountIds: string[], campaignFilter: string): { spend: number; error: string | null } {
    let spend = 0;
    let error: string | null = null;
    for (const accId of accountIds) {
      if (liveAccountError.has(accId)) { error = liveAccountError.get(accId)!; continue; }
      const rows = campaignRowsByAccount.get(accId) || [];
      for (const r of rows) {
        if (!matchesCampaignFilter(r.campaign_name, campaignFilter)) continue;
        spend += r.spend;
      }
    }
    return { spend: Math.round(spend * 100) / 100, error };
  }

  // --- GHL leads + bookings, in parallel across all clients with a token ---
  const ghlResults = await Promise.all(
    clients.map(async c => {
      if (!c.has_ghl_token) return { id: c.id, leads: null as number | null, bookings: null as number | null, error: null as string | null };
      try {
        const token = decrypt(c.ghl_token_enc);
        const [leadsResult, bookingsResult] = await Promise.all([
          fetchGhlLeads({ token, locationId: c.ghl_location_id }),
          fetchGhlBookings({ token, locationId: c.ghl_location_id }),
        ]);
        const leadContactIds = new Set(
          leadsResult.rows.filter(r => r.day >= since && r.day <= until).map(r => r.contactId)
        );
        const bookingContactIds = new Set(
          bookingsResult.rows.filter(r => r.day >= since && r.day <= until).map(r => r.contactId)
        );
        return { id: c.id, leads: leadContactIds.size, bookings: bookingContactIds.size, error: null };
      } catch (err) {
        const message = err instanceof GhlError ? err.message : (err instanceof Error ? err.message : 'GHL fetch failed');
        return { id: c.id, leads: null as number | null, bookings: null as number | null, error: message };
      }
    })
  );
  const ghlById = new Map(ghlResults.map(r => [r.id, r] as const));

  const results: RowResult[] = clients.map((c, i) => {
    const { spend, error: metaError } = spendForClient(scopes[i].accountIds, scopes[i].campaignFilter);
    const ghl = ghlById.get(c.id)!;
    const cpl = ghl.leads && ghl.leads > 0 ? Math.round((spend / ghl.leads) * 100) / 100 : null;
    return {
      client: c,
      leads: ghl.leads,
      bookings: ghl.bookings,
      spend,
      cpl,
      ghlError: ghl.error,
      metaError,
    };
  });

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Agency Overview</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Active clients — leads &amp; bookings from GoHighLevel, spend from Meta, CPL computed per client.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <OverviewRangeSelect currentDays={days} />
            <a
              href="/admin"
              className="text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors"
            >
              ← Back to admin
            </a>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Client</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Active</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Leads</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Bookings</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Meta Spend</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">CPL</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">No active clients.</td>
                </tr>
              )}
              {results.map(r => (
                <tr key={r.client.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                  <td className="px-4 py-3 font-medium text-white">{r.client.name}</td>
                  <td className="px-4 py-3">
                    <ActiveToggle clientId={r.client.id} current={r.client.active} compact />
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-200">
                    {r.ghlError ? (
                      <span className="text-xs text-red-400" title={r.ghlError}>GHL error</span>
                    ) : r.leads === null ? (
                      <span className="text-xs text-slate-600">Not configured</span>
                    ) : r.leads.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-200">
                    {r.ghlError ? (
                      <span className="text-xs text-red-400" title={r.ghlError}>GHL error</span>
                    ) : r.bookings === null ? (
                      <span className="text-xs text-slate-600">Not configured</span>
                    ) : r.bookings.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-200">
                    {r.metaError ? (
                      <span className="text-xs text-red-400" title={r.metaError}>Meta error</span>
                    ) : `$${r.spend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-200">
                    {r.cpl === null ? <span className="text-slate-600">—</span> : `$${r.cpl.toFixed(2)}`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <a href={`/admin/clients/${r.client.id}`} className="text-xs text-blue-400 hover:text-blue-300">
                      Manage →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
