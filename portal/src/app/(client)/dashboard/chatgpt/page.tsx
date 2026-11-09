import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { isGoogleOnlyClient } from '@/lib/meta';
import ImpersonationBanner from '@/components/ImpersonationBanner';
import ChatgptDashboard from './ChatgptDashboard';

interface ClientRow {
  name: string;
  has_chatgpt: boolean;
  google_sheet_tab: string;
  google_data_source: 'sheet' | 'api';
  google_ads_customer_ids: string[];
  ad_account_ids: string[] | null;
}

export default async function DashboardChatgptPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'client') redirect('/login');

  const [client] = await query<ClientRow>(
    `SELECT c.name, (c.chatgpt_ads_key_enc <> '' AND c.chatgpt_ads_account_id <> '') AS has_chatgpt,
            c.google_sheet_tab, c.google_data_source, c.google_ads_customer_ids, c.ad_account_ids
     FROM clients c JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1 LIMIT 1`,
    [session.user.id]
  );
  if (!client?.has_chatgpt) redirect('/dashboard');

  const hasGoogleAds = !!client.google_sheet_tab
    || (client.google_data_source === 'api' && (client.google_ads_customer_ids?.length ?? 0) > 0);
  const impersonatedBy = session.user.impersonatedBy;

  return (
    <>
      {impersonatedBy && (
        <ImpersonationBanner adminEmail={impersonatedBy.email} clientName={client.name} actorRole={impersonatedBy.role} returnTo={impersonatedBy.returnTo} />
      )}
      <ChatgptDashboard clientName={client.name} hasMeta={!isGoogleOnlyClient(client)} hasGoogleAds={hasGoogleAds} />
    </>
  );
}
