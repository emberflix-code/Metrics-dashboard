import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import DashboardClient from './DashboardClient';

interface BmConnectionRow {
  token_enc: string;
  account_ids: string[];
}

interface ClientRow {
  name: string;
  campaign_filter: string;
  ad_account_ids: string[];
  show_account: boolean;
  sheet_id: string;
  sheet_tab: string;
  google_sheet_tab: string;
  use_sheet_for_leads: boolean;
  leads_source: 'meta' | 'sheet' | 'ghl';
  show_bookings: boolean;
  show_book_rate: boolean;
  has_ghl_token: boolean;
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'client') redirect('/login');

  const connections = await query<BmConnectionRow>(
    `SELECT token_enc, account_ids FROM agency_bm_connections ORDER BY sort_order ASC, created_at ASC`
  );

  if (connections.length === 0) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="text-center">
          <div className="w-12 h-12 bg-slate-800 rounded-xl mx-auto mb-4 flex items-center justify-center">
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3C6.477 3 2 7.477 2 12s4.477 9 10 9 10-4.477 10-9S17.523 3 12 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">Not configured yet</h2>
          <p className="text-sm text-slate-400">Your agency hasn&apos;t connected their Meta Ads account yet.</p>
        </div>
      </div>
    );
  }

  // Verify the first connection's token decrypts (catches bad encryption at
  // page load instead of failing every API call).
  void decrypt(connections[0].token_enc);

  const [client] = await query<ClientRow>(
    `SELECT c.name, c.campaign_filter, c.ad_account_ids, c.show_account,
            c.sheet_id, c.sheet_tab, c.google_sheet_tab, c.use_sheet_for_leads,
            c.leads_source, c.show_bookings, c.show_book_rate,
            (length(c.ghl_token_enc) > 0) AS has_ghl_token
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  // Server-side resolver: collapse "wants source X but it's not configured"
  // into a usable source. Order: ghl → sheet → meta. The dashboard reads the
  // resolved source as-is and never has to second-guess the admin's intent.
  const requestedSource = client?.leads_source ?? 'meta';
  const resolvedLeadsSource: 'meta' | 'sheet' | 'ghl' =
    requestedSource === 'ghl' && client?.has_ghl_token ? 'ghl' :
    requestedSource === 'sheet' && client?.sheet_tab ? 'sheet' :
    requestedSource === 'ghl' && client?.sheet_tab ? 'sheet' :
    'meta';

  // Union all accounts across BM connections; client scope (if any) intersects.
  const allAgencyAccountIds = Array.from(new Set(connections.flatMap(c => c.account_ids || [])));
  const accountIds =
    client?.ad_account_ids?.length > 0
      ? client.ad_account_ids
      : allAgencyAccountIds;

  return (
    <DashboardClient
      accountIds={accountIds}
      clientName={client?.name ?? session.user.email ?? 'Client'}
      campaignFilter={client?.campaign_filter ?? ''}
      showAccount={client?.show_account ?? false}
      platform="meta"
      hasGoogleAds={!!client?.google_sheet_tab}
      googleUrl="/dashboard/google"
      useSheetForLeads={resolvedLeadsSource === 'sheet'}
      leadsSource={resolvedLeadsSource}
      showBookings={!!(client?.show_bookings && client?.has_ghl_token)}
      showBookRate={!!(client?.show_bookings && client?.show_book_rate && client?.has_ghl_token)}
    />
  );
}
