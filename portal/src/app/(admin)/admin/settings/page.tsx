import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import AgencyMetaForm from './AgencyMetaForm';

interface AgencySettings {
  meta_token_enc: string | null;
  meta_account_ids: string[];
  updated_at: string | null;
}

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  const [settings] = await query<AgencySettings>(
    `SELECT meta_token_enc, meta_account_ids, updated_at FROM agency_settings WHERE id = 1`
  );

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <a href="/admin" className="text-sm text-slate-400 hover:text-white">← Back to admin</a>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-lg font-bold text-white">Agency Meta Connection</h1>
            {settings?.meta_token_enc
              ? <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full">Connected</span>
              : <span className="text-xs bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-full">Not connected</span>
            }
          </div>
          <p className="text-sm text-slate-400 mb-5">
            One token and set of ad accounts for the whole agency. Each client filters by their campaign name keyword.
          </p>

          {settings?.meta_token_enc && settings.meta_account_ids.length > 0 && (
            <div className="mb-5 p-3 bg-slate-800/60 rounded-lg">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Current Ad Accounts</p>
              <div className="flex flex-wrap gap-2">
                {settings.meta_account_ids.map(id => (
                  <span key={id} className="text-xs bg-slate-700 text-slate-300 px-2 py-1 rounded font-mono">
                    act_{id}
                  </span>
                ))}
              </div>
              {settings.updated_at && (
                <p className="text-xs text-slate-500 mt-2">
                  Last updated {new Date(settings.updated_at).toLocaleString()}
                </p>
              )}
            </div>
          )}

          <AgencyMetaForm hasToken={!!settings?.meta_token_enc} />
        </div>
      </div>
    </div>
  );
}
