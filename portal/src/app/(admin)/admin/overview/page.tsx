import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { getAdminClientMetaScope, matchesCampaignFilter } from '@/lib/meta';
import { fetchGhlLeads, fetchGhlBookings, isQualifyingLead, GhlError } from '@/lib/ghl';
import ActiveToggle from '../clients/[id]/ActiveToggle';
import OverviewRangeSelect from './OverviewRangeSelect';
import MetricsPicker from './MetricsPicker';
import { parseMetricsParam } from './metrics';
import GhlConfigModal from './GhlConfigModal';
import GhlLeadsListModal from './GhlLeadsListModal';
import InlineTextField from './InlineTextField';
import InlineNumberField from './InlineNumberField';
import GroupBySelect, { GroupByKey } from './GroupBySelect';
import SearchBox from './SearchBox';
import { resolveDateRange } from './dateRange';
import { namePrefixGroup } from './grouping';

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
  ghl_leads_tag: string;
  active: boolean;
  marketing_type: string;
  offer: string;
  sort_order: number;
}

interface BmConnectionRow {
  token_enc: string;
  account_ids: string[];
}

interface CampaignSpendRow {
  campaign_name: string;
  spend: number;
  impressions: number;
  reach: number;
  linkClicks: number;
}

interface RowResult {
  client: ClientRow;
  leads: number | null;
  bookings: number | null;
  spend: number;
  impressions: number;
  reach: number;
  linkClicks: number;
  ctr: number | null;
  cpl: number | null;
  ghlError: string | null;
  metaError: string | null;
}

export default async function OverviewPage({ searchParams }: { searchParams: { preset?: string; since?: string; until?: string; metrics?: string; group_by?: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  const { preset, since, until } = resolveDateRange(searchParams);
  const selectedMetrics = parseMetricsParam(searchParams.metrics);
  const groupBy: GroupByKey = (['prefix', 'marketing_type', 'offer'].includes(searchParams.group_by || '') ? searchParams.group_by : 'none') as GroupByKey;

  const clients = await query<ClientRow>(`
    SELECT c.id, c.name, u.email, c.ad_account_ids, c.campaign_filter,
           c.data_source, c.leads_source,
           (length(c.ghl_token_enc) > 0) AS has_ghl_token,
           c.ghl_token_enc, c.ghl_location_id, c.ghl_leads_tag, c.active,
           c.marketing_type, c.offer, c.sort_order
    FROM clients c
    JOIN client_users cu ON cu.client_id = c.id
    JOIN users u ON u.id = cu.user_id
    WHERE c.active = true
    ORDER BY c.sort_order ASC, c.name ASC
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

  // --- Spend + optional metrics: split by data_source, dedupe by unique account_id ---
  const cachedAccountIds = new Set<string>();
  const liveAccountIds = new Set<string>();
  clients.forEach((c, i) => {
    for (const accId of scopes[i].accountIds) {
      if (c.data_source === 'cached') cachedAccountIds.add(accId);
      else liveAccountIds.add(accId);
    }
  });

  const campaignRowsByAccount = new Map<string, CampaignSpendRow[]>();
  if (cachedAccountIds.size > 0) {
    const rows = await query<{ account_id: string; campaign_name: string; spend: string; impressions: string; reach: string; link_clicks: string }>(
      `SELECT account_id, campaign_name, SUM(spend)::text AS spend, SUM(impressions)::text AS impressions,
              SUM(reach)::text AS reach, SUM(link_clicks)::text AS link_clicks
       FROM meta_daily_insights
       WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3
       GROUP BY account_id, campaign_name`,
      [Array.from(cachedAccountIds), since, until]
    );
    for (const r of rows) {
      const list = campaignRowsByAccount.get(r.account_id) || [];
      list.push({
        campaign_name: r.campaign_name || '',
        spend: parseFloat(r.spend) || 0,
        impressions: parseInt(r.impressions, 10) || 0,
        reach: parseInt(r.reach, 10) || 0,
        linkClicks: parseInt(r.link_clicks, 10) || 0,
      });
      campaignRowsByAccount.set(r.account_id, list);
    }
  }

  // Live accounts: one Graph API call per unique account, in parallel.
  const liveAccountError = new Map<string, string>();
  const liveResults = await Promise.all(
    Array.from(liveAccountIds).map(async accId => {
      const tokenEnc = tokenByAccountId.get(accId);
      if (!tokenEnc) { liveAccountError.set(accId, 'No Meta connection for this account'); return { accId, rows: [] as CampaignSpendRow[] }; }
      try {
        const token = decrypt(tokenEnc);
        const url = new URL(`https://graph.facebook.com/v22.0/act_${accId}/insights`);
        url.searchParams.set('fields', 'campaign_name,spend,impressions,reach,inline_link_clicks');
        url.searchParams.set('level', 'campaign');
        url.searchParams.set('time_range', JSON.stringify({ since, until }));
        url.searchParams.set('limit', '500');
        url.searchParams.set('access_token', token);
        const res = await fetch(url.toString());
        const json = await res.json();
        if (!res.ok) { liveAccountError.set(accId, json?.error?.message || `Meta API error ${res.status}`); return { accId, rows: [] }; }
        const rows: CampaignSpendRow[] = (json.data || []).map((d: { campaign_name?: string; spend?: string; impressions?: string; reach?: string; inline_link_clicks?: string }) => ({
          campaign_name: d.campaign_name || '',
          spend: parseFloat(d.spend || '0') || 0,
          impressions: parseInt(d.impressions || '0', 10) || 0,
          reach: parseInt(d.reach || '0', 10) || 0,
          linkClicks: parseInt(d.inline_link_clicks || '0', 10) || 0,
        }));
        return { accId, rows };
      } catch (err) {
        liveAccountError.set(accId, err instanceof Error ? err.message : 'Meta fetch failed');
        return { accId, rows: [] as CampaignSpendRow[] };
      }
    })
  );
  for (const { accId, rows } of liveResults) campaignRowsByAccount.set(accId, rows);

  function metaForClient(accountIds: string[], campaignFilter: string) {
    let spend = 0, impressions = 0, reach = 0, linkClicks = 0;
    let error: string | null = null;
    for (const accId of accountIds) {
      if (liveAccountError.has(accId)) { error = liveAccountError.get(accId)!; continue; }
      const rows = campaignRowsByAccount.get(accId) || [];
      for (const r of rows) {
        if (!matchesCampaignFilter(r.campaign_name, campaignFilter)) continue;
        spend += r.spend;
        impressions += r.impressions;
        reach += r.reach;
        linkClicks += r.linkClicks;
      }
    }
    return { spend: Math.round(spend * 100) / 100, impressions, reach, linkClicks, error };
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
          leadsResult.rows
            .filter(r => r.day >= since && r.day <= until && isQualifyingLead(r, c.ghl_leads_tag))
            .map(r => r.contactId)
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
    const meta = metaForClient(scopes[i].accountIds, scopes[i].campaignFilter);
    const ghl = ghlById.get(c.id)!;
    const cpl = ghl.leads && ghl.leads > 0 ? Math.round((meta.spend / ghl.leads) * 100) / 100 : null;
    const ctr = meta.impressions > 0 ? Math.round((meta.linkClicks / meta.impressions) * 10000) / 100 : null;
    return {
      client: c,
      leads: ghl.leads,
      bookings: ghl.bookings,
      spend: meta.spend,
      impressions: meta.impressions,
      reach: meta.reach,
      linkClicks: meta.linkClicks,
      ctr,
      cpl,
      ghlError: ghl.error,
      metaError: meta.error,
    };
  });

  // --- Grouping ---
  function groupKeyFor(r: RowResult): string {
    if (groupBy === 'prefix') return namePrefixGroup(r.client.name);
    if (groupBy === 'marketing_type') return r.client.marketing_type || '(none)';
    if (groupBy === 'offer') return r.client.offer || '(none)';
    return '';
  }

  const groupsMap = new Map<string, RowResult[]>();
  if (groupBy !== 'none') {
    for (const r of results) {
      const key = groupKeyFor(r);
      const list = groupsMap.get(key) || [];
      list.push(r);
      groupsMap.set(key, list);
    }
  }
  const sortedGroupKeys = Array.from(groupsMap.keys()).sort((a, b) => a.localeCompare(b));

  function subtotal(rows: RowResult[]) {
    const spend = Math.round(rows.reduce((s, r) => s + r.spend, 0) * 100) / 100;
    const leads = rows.reduce((s, r) => s + (r.leads ?? 0), 0);
    const bookings = rows.reduce((s, r) => s + (r.bookings ?? 0), 0);
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const reach = rows.reduce((s, r) => s + r.reach, 0);
    const linkClicks = rows.reduce((s, r) => s + r.linkClicks, 0);
    const ctr = impressions > 0 ? Math.round((linkClicks / impressions) * 10000) / 100 : null;
    const cpl = leads > 0 ? Math.round((spend / leads) * 100) / 100 : null;
    return { spend, leads, bookings, impressions, reach, linkClicks, ctr, cpl };
  }

  const colSpan = 8 + selectedMetrics.size;

  function renderRow(r: RowResult, groupKey?: string) {
    const searchable = [r.client.name, r.client.marketing_type, r.client.offer].join(' ').toLowerCase();
    return (
      <tr
        key={r.client.id}
        className="border-b border-slate-800/50 hover:bg-slate-800/30"
        data-search={searchable}
        data-group={groupKey}
      >
        <td className="px-4 py-3">
          <InlineNumberField clientId={r.client.id} field="sort_order" value={r.client.sort_order} />
        </td>
        <td className="px-4 py-3 font-medium text-white">{r.client.name}</td>
        <td className="px-4 py-3">
          <ActiveToggle clientId={r.client.id} current={r.client.active} compact />
        </td>
        <td className="px-4 py-3 w-32">
          <InlineTextField clientId={r.client.id} field="marketing_type" value={r.client.marketing_type} placeholder="Add type…" />
        </td>
        <td className="px-4 py-3 w-32">
          <InlineTextField clientId={r.client.id} field="offer" value={r.client.offer} placeholder="Add offer…" />
        </td>
        <td className="px-4 py-3 text-right font-mono text-slate-200">
          {r.ghlError ? (
            <span className="text-xs text-red-400" title={r.ghlError}>GHL error</span>
          ) : r.leads === null ? (
            <GhlConfigModal
              clientId={r.client.id}
              clientName={r.client.name}
              currentLocationId={r.client.ghl_location_id}
              currentLeadsTag={r.client.ghl_leads_tag}
              hasToken={false}
            />
          ) : (
            <GhlConfigModal
              clientId={r.client.id}
              clientName={r.client.name}
              currentLocationId={r.client.ghl_location_id}
              currentLeadsTag={r.client.ghl_leads_tag}
              hasToken
            >
              <GhlLeadsListModal
                clientId={r.client.id}
                clientName={r.client.name}
                since={since}
                until={until}
                count={r.leads}
              />
            </GhlConfigModal>
          )}
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
        {selectedMetrics.has('impressions') && <td className="px-4 py-3 text-right font-mono text-slate-200">{r.impressions.toLocaleString()}</td>}
        {selectedMetrics.has('reach') && <td className="px-4 py-3 text-right font-mono text-slate-200">{r.reach.toLocaleString()}</td>}
        {selectedMetrics.has('link_clicks') && <td className="px-4 py-3 text-right font-mono text-slate-200">{r.linkClicks.toLocaleString()}</td>}
        {selectedMetrics.has('ctr') && <td className="px-4 py-3 text-right font-mono text-slate-200">{r.ctr === null ? '—' : `${r.ctr.toFixed(2)}%`}</td>}
        <td className="px-4 py-3 text-right font-mono text-slate-200">
          {r.cpl === null ? <span className="text-slate-600">—</span> : `$${r.cpl.toFixed(2)}`}
        </td>
        <td className="px-4 py-3 text-right">
          <a href={`/admin/clients/${r.client.id}`} className="text-xs text-blue-400 hover:text-blue-300">
            Manage →
          </a>
        </td>
      </tr>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">Agency Overview</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Active clients — leads &amp; bookings from GoHighLevel, spend from Meta, CPL computed per client.
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <SearchBox />
            <GroupBySelect current={groupBy} />
            <MetricsPicker current={selectedMetrics} />
            <OverviewRangeSelect currentPreset={preset} currentSince={since} currentUntil={until} />
            <a
              href="/admin"
              className="text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors"
            >
              ← Back to admin
            </a>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm" data-overview-table>
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">#</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Client</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Active</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Marketing Type</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Offer</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Leads</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Bookings</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Meta Spend</th>
                {selectedMetrics.has('impressions') && <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Impressions</th>}
                {selectedMetrics.has('reach') && <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Reach</th>}
                {selectedMetrics.has('link_clicks') && <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Link Clicks</th>}
                {selectedMetrics.has('ctr') && <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">CTR</th>}
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">CPL</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-8 text-center text-slate-500">No active clients.</td>
                </tr>
              )}
              {groupBy === 'none'
                ? results.map(r => renderRow(r))
                : sortedGroupKeys.flatMap(key => {
                    const rows = groupsMap.get(key)!;
                    const sub = subtotal(rows);
                    return [
                      <tr key={`group-${key}`} className="bg-slate-800/60 border-b border-slate-800" data-group-header={key}>
                        <td className="px-4 py-2 font-semibold text-slate-200" colSpan={5}>
                          {key} <span className="text-slate-500 font-normal">({rows.length})</span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300">{sub.leads.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300">{sub.bookings.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300">${sub.spend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        {selectedMetrics.has('impressions') && <td className="px-4 py-2 text-right font-mono text-slate-300">{sub.impressions.toLocaleString()}</td>}
                        {selectedMetrics.has('reach') && <td className="px-4 py-2 text-right font-mono text-slate-300">{sub.reach.toLocaleString()}</td>}
                        {selectedMetrics.has('link_clicks') && <td className="px-4 py-2 text-right font-mono text-slate-300">{sub.linkClicks.toLocaleString()}</td>}
                        {selectedMetrics.has('ctr') && <td className="px-4 py-2 text-right font-mono text-slate-300">{sub.ctr === null ? '—' : `${sub.ctr.toFixed(2)}%`}</td>}
                        <td className="px-4 py-2 text-right font-mono text-slate-300">{sub.cpl === null ? '—' : `$${sub.cpl.toFixed(2)}`}</td>
                        <td className="px-4 py-2"></td>
                      </tr>,
                      ...rows.map(r => renderRow(r, key)),
                    ];
                  })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
