import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import CampaignFilterForm from './CampaignFilterForm';
import AdAccountSelector from './AdAccountSelector';
import ShowAccountToggle from './ShowAccountToggle';
import SheetConfigForm from './SheetConfigForm';
import ResetPasswordForm from './ResetPasswordForm';
import AutoLoginLink from './AutoLoginLink';

interface ClientDetail {
  id: string;
  name: string;
  email: string;
  created_at: string;
  auto_login_token: string | null;
  campaign_filter: string;
  ad_account_ids: string[];
  show_account: boolean;
  sheet_id: string;
  sheet_tab: string;
  google_sheet_tab: string;
  use_sheet_for_leads: boolean;
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
    SELECT c.id, c.name, c.campaign_filter, c.ad_account_ids, c.show_account, c.sheet_id, c.sheet_tab, c.google_sheet_tab, c.use_sheet_for_leads, c.created_at, u.email, u.auto_login_token
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

        {/* Dashboard display settings */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">Dashboard Display</h2>
          <p className="text-sm text-slate-400 mb-5">Control what this client sees on their dashboard.</p>
          <ShowAccountToggle clientId={client.id} current={client.show_account ?? false} />
        </div>

        {/* Google Sheet config */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">Google Sheet — Leads</h2>
          <p className="text-sm text-slate-400 mb-5">
            Connect a Google Sheet to show leads data on this client&apos;s dashboard.
          </p>
          <SheetConfigForm
            clientId={client.id}
            currentSheetId={client.sheet_id ?? ''}
            currentSheetTab={client.sheet_tab ?? ''}
            currentGoogleSheetTab={client.google_sheet_tab ?? ''}
            currentUseSheetForLeads={client.use_sheet_for_leads ?? false}
          />
        </div>

        {/* Auto-login link for GHL embed */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">Auto-Login Link</h2>
          <p className="text-sm text-slate-400 mb-5">
            Use this URL as the iframe src in GoHighLevel. The client lands directly on their dashboard — no password needed.
          </p>
          <AutoLoginLink clientId={client.id} initialToken={client.auto_login_token} />
        </div>

        {/* Reset password */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">Reset Password</h2>
          <p className="text-sm text-slate-400 mb-5">
            Override this client&apos;s password. They&apos;ll need to sign in with the new password next time.
          </p>
          <ResetPasswordForm clientId={client.id} clientEmail={client.email} />
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
