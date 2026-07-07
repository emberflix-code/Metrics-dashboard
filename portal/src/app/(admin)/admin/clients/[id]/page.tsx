import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import CampaignFilterForm from './CampaignFilterForm';
import AdAccountSelector from './AdAccountSelector';
import ShowAccountToggle from './ShowAccountToggle';
import SheetConfigForm from './SheetConfigForm';
import GhlConfigForm from './GhlConfigForm';
import ResetPasswordForm from './ResetPasswordForm';
import AutoLoginLink from './AutoLoginLink';
import ImpersonateButton from './ImpersonateButton';

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
  leads_source: 'meta' | 'sheet' | 'ghl';
  show_bookings: boolean;
  show_book_rate: boolean;
  ghl_location_id: string;
  has_ghl_token: boolean;
}

interface AgencyAccount {
  id: string;
  name: string;
  bmLabel?: string;
}

interface BmConnectionRow {
  label: string;
  account_ids: string[];
  accounts_json: { id: string; name?: string }[];
}

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  const [client] = await query<ClientDetail>(`
    SELECT c.id, c.name, c.campaign_filter, c.ad_account_ids, c.show_account,
           c.sheet_id, c.sheet_tab, c.google_sheet_tab, c.use_sheet_for_leads,
           c.leads_source, c.show_bookings, c.show_book_rate, c.ghl_location_id,
           (length(c.ghl_token_enc) > 0) AS has_ghl_token,
           c.created_at, u.email, u.auto_login_token
    FROM clients c
    JOIN client_users cu ON cu.client_id = c.id
    JOIN users u ON u.id = cu.user_id
    WHERE c.id = $1
  `, [params.id]);

  if (!client) redirect('/admin');

  // Build a unified list of accounts across all BM connections so the admin
  // can assign accounts from any BM to this client.
  const bmRows = await query<BmConnectionRow>(
    `SELECT label, account_ids, accounts_json
     FROM agency_bm_connections
     ORDER BY sort_order ASC, created_at ASC`
  );
  const agencyAccounts: AgencyAccount[] = [];
  for (const bm of bmRows) {
    const nameById = new Map<string, string>();
    for (const a of bm.accounts_json || []) if (a.id) nameById.set(a.id, a.name || '');
    for (const id of bm.account_ids || []) {
      agencyAccounts.push({ id, name: nameById.get(id) || '', bmLabel: bm.label });
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <a href="/admin" className="text-sm text-slate-400 hover:text-white">← Back to admin</a>
        </div>

        {/* Client info */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-lg font-bold text-white">{client.name}</h1>
              <p className="text-sm text-slate-400 mt-0.5">{client.email}</p>
            </div>
            <span className="text-xs text-slate-500">
              Created {new Date(client.created_at).toLocaleDateString()}
            </span>
          </div>
          <ImpersonateButton clientId={client.id} clientName={client.name} />
          <p className="mt-2 text-xs text-slate-500">
            Opens this client&apos;s dashboard as if you were signed in as them. A banner at the top lets you return to admin.
          </p>
        </div>

        {/* Ad Account Assignment */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">Ad Accounts</h2>
          <p className="text-sm text-slate-400 mb-5">
            Select which agency ad accounts this client can see data from.
          </p>
          <AdAccountSelector
            clientId={client.id}
            agencyAccounts={agencyAccounts}
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
            currentLeadsSource={client.leads_source ?? 'meta'}
            hasGhlToken={!!client.has_ghl_token}
          />
        </div>

        {/* GoHighLevel — Bookings */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-1">GoHighLevel — Bookings</h2>
          <p className="text-sm text-slate-400 mb-5">
            Connect a GHL Private Integration token to surface booked-contact attribution on the dashboard. Counts contacts tagged <span className="font-mono text-slate-300">booked appointment</span> within 30 days of opt-in.
          </p>
          <GhlConfigForm
            clientId={client.id}
            hasToken={!!client.has_ghl_token}
            currentLocationId={client.ghl_location_id ?? ''}
            currentShowBookings={client.show_bookings ?? false}
            currentShowBookRate={client.show_book_rate ?? false}
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
