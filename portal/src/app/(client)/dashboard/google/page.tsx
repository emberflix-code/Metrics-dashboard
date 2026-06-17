import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import DashboardClient from '../DashboardClient';

interface ClientRow {
  name: string;
  show_account: boolean;
  sheet_id: string;
  google_sheet_tab: string;
}

export default async function DashboardGooglePage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'client') redirect('/login');

  const [client] = await query<ClientRow>(
    `SELECT c.name, c.show_account, c.sheet_id, c.google_sheet_tab
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  if (!client?.sheet_id || !client?.google_sheet_tab) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <div className="w-12 h-12 bg-slate-800 rounded-xl mx-auto mb-4 flex items-center justify-center">
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3C6.477 3 2 7.477 2 12s4.477 9 10 9 10-4.477 10-9S17.523 3 12 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">Google Ads dashboard not configured</h2>
          <p className="text-sm text-slate-400 mb-4">Your agency hasn&apos;t set up a Google Ads sheet tab for this client yet.</p>
          <a href="/dashboard" className="text-sm text-blue-400 hover:text-blue-300">← Back to Meta dashboard</a>
        </div>
      </div>
    );
  }

  return (
    <DashboardClient
      accountIds={[]}
      clientName={client.name ?? session.user.email ?? 'Client'}
      campaignFilter=""
      showAccount={false}
      platform="google"
      hasGoogleAds={true}
      metaUrl="/dashboard"
    />
  );
}
