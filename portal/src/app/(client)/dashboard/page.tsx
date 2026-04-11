import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import DashboardClient from './DashboardClient';

interface AgencySettings {
  meta_token_enc: string | null;
  meta_account_ids: string[];
}

interface ClientRow {
  name: string;
  campaign_filter: string;
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'client') redirect('/login');

  const [agency] = await query<AgencySettings>(
    `SELECT meta_token_enc, meta_account_ids FROM agency_settings WHERE id = 1`
  );

  if (!agency?.meta_token_enc) {
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

  // Verify token decrypts server-side — never sent to client JS
  void decrypt(agency.meta_token_enc);

  const [client] = await query<ClientRow>(
    `SELECT c.name, c.campaign_filter
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  return (
    <DashboardClient
      accountIds={agency.meta_account_ids}
      clientName={client?.name ?? session.user.email ?? 'Client'}
      campaignFilter={client?.campaign_filter ?? ''}
    />
  );
}
