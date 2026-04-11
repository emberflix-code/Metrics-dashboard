import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import { query } from './db';
import { decrypt } from './crypto';

interface AgencySettings {
  meta_token_enc: string | null;
  meta_account_ids: string[];
}

interface ClientRow {
  campaign_filter: string;
}

/**
 * Returns the agency-level Meta token + account IDs, plus the current
 * client's campaign_filter so the dashboard can scope campaigns by name.
 */
export async function getClientConnection(): Promise<{
  token: string;
  accountIds: string[];
  campaignFilter: string;
}> {
  const session = await getServerSession(authOptions);
  if (!session) throw new Error('Unauthorized');

  const [agency] = await query<AgencySettings>(
    `SELECT meta_token_enc, meta_account_ids FROM agency_settings WHERE id = 1`
  );

  if (!agency?.meta_token_enc) throw new Error('Agency Meta connection not configured');

  const [client] = await query<ClientRow>(
    `SELECT c.campaign_filter
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  return {
    token: decrypt(agency.meta_token_enc),
    accountIds: agency.meta_account_ids,
    campaignFilter: client?.campaign_filter ?? '',
  };
}

/** Strip access_token from paging.next before sending to client. */
export function sanitizePaging(json: Record<string, unknown>): Record<string, unknown> {
  const paging = json?.paging as Record<string, unknown> | undefined;
  if (paging?.next) {
    try {
      const url = new URL(paging.next as string);
      url.searchParams.delete('access_token');
      paging.next = url.toString();
    } catch { /* non-URL paging.next — leave as-is */ }
  }
  return json;
}
