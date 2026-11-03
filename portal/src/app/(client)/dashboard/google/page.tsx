import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { isGoogleOnlyClient } from '@/lib/meta';
import DashboardClient from '../DashboardClient';
import ImpersonationBanner from '@/components/ImpersonationBanner';

interface ClientRow {
  name: string;
  show_account: boolean;
  sheet_id: string;
  google_sheet_tab: string;
  google_data_source: 'sheet' | 'api';
  google_ads_customer_ids: string[];
  ad_account_ids: string[] | null;
}

export default async function DashboardGooglePage({
  searchParams,
}: {
  searchParams: Promise<{ _al?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'client') redirect('/login');

  // Carried forward from /dashboard's redirect for Google-only clients (see
  // there) so the Refresh button can re-enter through auto-login.
  const { _al: autoLoginToken } = await searchParams;

  const [client] = await query<ClientRow>(
    `SELECT c.name, c.show_account, c.sheet_id, c.google_sheet_tab,
            c.google_data_source, c.google_ads_customer_ids, c.ad_account_ids
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  // 'api' reads google_ads_daily (Google Ads API); 'sheet' reads google_sheet_tab.
  const googleDataSource: 'sheet' | 'api' = client?.google_data_source === 'api' ? 'api' : 'sheet';
  const configured = googleDataSource === 'api'
    ? (client?.google_ads_customer_ids?.length ?? 0) > 0
    : !!(client?.sheet_id && client?.google_sheet_tab);

  if (!configured) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <div className="w-12 h-12 bg-slate-800 rounded-xl mx-auto mb-4 flex items-center justify-center">
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3C6.477 3 2 7.477 2 12s4.477 9 10 9 10-4.477 10-9S17.523 3 12 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">Google Ads dashboard not configured</h2>
          <p className="text-sm text-slate-400 mb-4">Your agency hasn&apos;t set up Google Ads data for this client yet.</p>
          <a href="/dashboard" className="text-sm text-blue-400 hover:text-blue-300">← Back to Meta dashboard</a>
        </div>
      </div>
    );
  }

  const impersonatedBy = session.user.impersonatedBy;
  const clientName = client.name ?? session.user.email ?? 'Client';

  return (
    <>
      {impersonatedBy && (
        <ImpersonationBanner adminEmail={impersonatedBy.email} clientName={clientName} />
      )}
      <DashboardClient
        accountIds={[]}
        clientName={clientName}
        campaignFilter=""
        showAccount={false}
        platform="google"
        googleDataSource={googleDataSource}
        hasGoogleAds={true}
        hasMeta={!isGoogleOnlyClient(client)}
        metaUrl="/dashboard"
        isAdminView={!!impersonatedBy}
        autoLoginToken={autoLoginToken}
      />
    </>
  );
}
