import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import BmConnectionsManager from './BmConnectionsManager';
import PageTokenManager from './PageTokenManager';
import MarketersManager from './MarketersManager';

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <a href="/admin" className="text-sm text-slate-400 hover:text-white">← Back to admin</a>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h1 className="text-lg font-bold text-white mb-1">Meta Business Managers</h1>
          <p className="text-sm text-slate-400 mb-5">
            Each Business Manager has its own access token and ad account list. A client&apos;s dashboard can pull data from accounts across any BM you&apos;ve connected here.
          </p>
          <BmConnectionsManager />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h1 className="text-lg font-bold text-white mb-1">Page token</h1>
          <p className="text-sm text-slate-400 mb-5">
            One agency-wide Page token powering two per-client features: sharper creative images (Page-content image fallback) and instant-form lead names on the Leads KPI card. Enable either in that client&apos;s settings.
          </p>
          <PageTokenManager />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h1 className="text-lg font-bold text-white mb-1">Marketing specialists</h1>
          <p className="text-sm text-slate-400 mb-5">
            Logins for the <span className="font-mono text-slate-300">marketer</span> role. A specialist sees every active client at once under{' '}
            <a href="/marketer" className="text-blue-300 hover:text-blue-200">/marketer</a> (targeting overlap, asset library, alerts) and can tag creatives, but has no access to this admin panel or to client settings.
          </p>
          <MarketersManager />
        </div>
      </div>
    </div>
  );
}
