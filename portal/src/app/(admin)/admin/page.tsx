import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { SignOutButton } from './SignOutButton';
import { ChangePasswordButton } from '@/components/ChangePasswordButton';

interface ClientRow {
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
  meta_token_enc: string | null;
  meta_accounts: AgencyAccount[];
}

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  const [agency] = await query<AgencySettings>(
    `SELECT meta_token_enc, meta_accounts FROM agency_settings WHERE id = 1`
  );

  const clients = await query<ClientRow>(`
    SELECT c.id, c.name, c.campaign_filter, c.ad_account_ids, c.created_at, u.email
    FROM clients c
    JOIN client_users cu ON cu.client_id = c.id
    JOIN users u ON u.id = cu.user_id
    ORDER BY c.created_at DESC
  `);

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">Admin Panel</h1>
            <p className="text-sm text-slate-400 mt-0.5">Manage clients and Meta connection</p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/admin/settings"
              className="flex items-center gap-2 text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors"
            >
              <span className="text-xs">⚙</span> Agency Settings
              {!agency?.meta_token_enc && (
                <span className="text-xs bg-red-500/10 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded-full">!</span>
              )}
            </a>
            <a
              href="/admin/clients/new"
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              + New Client
            </a>
            <ChangePasswordButton />
            <SignOutButton />
          </div>
        </div>

        {!agency?.meta_token_enc && (
          <div className="mb-4 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm text-amber-300">
            <strong>No Meta connection yet.</strong>{' '}
            <a href="/admin/settings" className="underline hover:text-amber-200">Set up the agency connection</a>{' '}
            before clients can view their dashboards.
          </div>
        )}

        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Client</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Email</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Ad Accounts</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Campaign Filter</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Created</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {clients.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    No clients yet. Create your first client.
                  </td>
                </tr>
              )}
              {clients.map(c => (
                <tr key={c.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                  <td className="px-4 py-3 font-medium text-white">{c.name}</td>
                  <td className="px-4 py-3 text-slate-300">{c.email}</td>
                  <td className="px-4 py-3">
                    {c.ad_account_ids?.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {c.ad_account_ids.map(id => {
                          const acc = agency?.meta_accounts?.find(a => a.id === id);
                          return (
                            <span key={id} className="text-xs font-mono text-slate-300">
                              {acc?.name ? <><span className="text-slate-200">{acc.name}</span><span className="text-slate-500 ml-1">({id})</span></> : `act_${id}`}
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-600">— all accounts —</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.campaign_filter
                      ? <code className="text-xs bg-slate-800 text-blue-300 px-2 py-0.5 rounded">{c.campaign_filter}</code>
                      : <span className="text-xs text-slate-600">— all campaigns —</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-slate-400">{new Date(c.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <a href={`/admin/clients/${c.id}`} className="text-xs text-blue-400 hover:text-blue-300">
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
