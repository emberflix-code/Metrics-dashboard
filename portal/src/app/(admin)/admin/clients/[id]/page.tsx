import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import CampaignFilterForm from './CampaignFilterForm';
import AdAccountSelector from './AdAccountSelector';

interface ClientDetail {
  id: string;
  name: string;
  email: string;
  created_at: string;
  campaign_filter: string;
  ad_account_ids: string[];
}

interface AgencyAccount {
  id: string;
  name: string;
}

interface AgencySettings {
  meta_account_ids: string[];
  meta_accounts: AgencyAccount[];
}

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  const [client] = await query<ClientDetail>(`
    SELECT c.id, c.name, c.campaign_filter, c.ad_account_ids, c.created_at, u.email
    FROM clients c
    JOIN client_users cu ON cu.client_id = c.id
    JOIN users u ON u.id = cu.user_id
    WHERE c.id = $1
  `, [params.id]);

  if (!client) redirect('/admin');

  const [agency] = await query<AgencySettings>(
    `SELECT meta_account_ids, meta_accounts FROM agency_settings WHERE id = 1`
  );

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <a href="/admin" className="text-sm text-slate-400 hover:text-white">← Back to admin</a>
        </div>

        {/* Client info */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-bold text-white">{client.name}</h1>
              <p className="text-sm text-slate-400 mt-0.5">{client.email}</p>
            </div>
            <span className="text-xs text-slate-500">
              Created {new Date(client.created_at).toLocaleDateString()}
            </span>
          </div>
        </div>

        {/* Ad Account Assignment */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">Ad Accounts</h2>
          <p className="text-sm text-slate-400 mb-5">
            Select which agency ad accounts this client can see data from.
          </p>
          <AdAccountSelector
            clientId={client.id}
            agencyAccounts={agency?.meta_accounts?.length ? agency.meta_accounts : (agency?.meta_account_ids ?? []).map(id => ({ id, name: '' }))}
            currentAccountIds={client.ad_account_ids ?? []}
          />
        </div>

        {/* Campaign filter */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">Campaign Filter</h2>
          <p className="text-sm text-slate-400 mb-5">
            Campaigns whose name contains this keyword (case-insensitive) will be shown to this client.
            Leave blank to show all campaigns — not recommended.
          </p>
          <CampaignFilterForm clientId={client.id} currentFilter={client.campaign_filter} />
        </div>
      </div>
    </div>
  );
}
