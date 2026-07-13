import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import { query } from './db';
import { decrypt } from './crypto';

interface BmConnectionRow {
  id: string;
  label: string;
  token_enc: string;
  account_ids: string[];
  accounts_json: { id: string; name?: string }[];
}

interface ClientRow {
  campaign_filter: string;
}

export interface AgencyAccount {
  id: string;
  name: string;
  bmLabel: string;
}

export interface ClientConnection {
  /** All ad account IDs accessible to this client (across every BM). */
  accountIds: string[];
  /** Full account metadata with the BM label, for UI grouping. */
  accounts: AgencyAccount[];
  /** Look up the right token for a given ad account ID. Throws if unknown. */
  tokenForAccount(accountId: string): string;
  /** Campaign-name substring filter the client wants applied. */
  campaignFilter: string;
  /**
   * Default token — used by routes that don't yet take an account_id, or for
   * agency-wide operations. Picks the first connection's token. Will be
   * removed once every route is per-account.
   */
  token: string;
}

/**
 * Returns the agency's Meta connections (one per BM) merged with the current
 * client's account scope. Routes call tokenForAccount(accountId) to pick the
 * right token for each Meta API call.
 */
export async function getClientConnection(): Promise<ClientConnection> {
  const session = await getServerSession(authOptions);
  if (!session) throw new Error('Unauthorized');

  const connections = await query<BmConnectionRow>(
    `SELECT id, label, token_enc, account_ids, accounts_json
     FROM agency_bm_connections
     ORDER BY sort_order ASC, created_at ASC`
  );
  if (connections.length === 0) throw new Error('Agency Meta connection not configured');

  // Build an account → connection lookup so any route can resolve the right token.
  const accountToConnection = new Map<string, BmConnectionRow>();
  const allAccounts: AgencyAccount[] = [];
  for (const conn of connections) {
    const nameLookup = new Map<string, string>();
    for (const a of conn.accounts_json || []) if (a.id) nameLookup.set(a.id, a.name || '');
    for (const accId of conn.account_ids || []) {
      accountToConnection.set(accId, conn);
      allAccounts.push({ id: accId, name: nameLookup.get(accId) || '', bmLabel: conn.label });
    }
  }

  // Optional per-client scope: clients.ad_account_ids restricts which accounts
  // this client can see. If empty/null, the client sees every agency account.
  const [client] = await query<{ campaign_filter: string; ad_account_ids: string[] | null }>(
    `SELECT c.campaign_filter, c.ad_account_ids
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  let scopedAccounts = allAccounts;
  if (client?.ad_account_ids && client.ad_account_ids.length > 0) {
    const allowed = new Set(client.ad_account_ids);
    scopedAccounts = allAccounts.filter(a => allowed.has(a.id));
  }

  const tokenForAccount = (accountId: string): string => {
    const conn = accountToConnection.get(accountId);
    if (!conn) throw new Error(`No Meta connection found for ad account ${accountId}`);
    return decrypt(conn.token_enc);
  };

  // Default token: first connection's token, for routes that haven't been
  // updated to per-account lookup yet. Safe because old single-BM clients
  // only had one connection.
  const defaultToken = decrypt(connections[0].token_enc);

  return {
    accountIds: scopedAccounts.map(a => a.id),
    accounts: scopedAccounts,
    tokenForAccount,
    campaignFilter: (client as ClientRow | undefined)?.campaign_filter ?? '',
    token: defaultToken,
  };
}

export interface ClientDbScope {
  /** Every ad account ID this client is allowed to see (already resolved — never empty-means-all). */
  accountIds: string[];
  /** Campaign-name substring/multi-keyword filter the client wants applied. */
  campaignFilter: string;
}

/**
 * Session-bound account/filter resolution for the DB-backed (`cached` mode)
 * read routes under /api/meta/db/* — same session + client_users scoping as
 * getClientConnection(), but without resolving a Meta token (DB reads don't
 * need one). Like getClientConnection(), an empty clients.ad_account_ids
 * resolves to every agency account (from agency_bm_connections) rather than
 * being left empty — callers can rely on accountIds always being the final
 * allowed set.
 */
export async function getClientDbScope(): Promise<ClientDbScope> {
  const session = await getServerSession(authOptions);
  if (!session) throw new Error('Unauthorized');

  const [client] = await query<{ campaign_filter: string; ad_account_ids: string[] | null }>(
    `SELECT c.campaign_filter, c.ad_account_ids
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  let accountIds = client?.ad_account_ids ?? [];
  if (accountIds.length === 0) {
    const rows = await query<{ account_ids: string[] }>(`SELECT account_ids FROM agency_bm_connections`);
    accountIds = Array.from(new Set(rows.flatMap(r => r.account_ids || [])));
  }

  return {
    accountIds,
    campaignFilter: client?.campaign_filter ?? '',
  };
}

/**
 * campaign_filter supports `|`-separated keywords for OR matching (e.g. a
 * region umbrella client spanning several states: ", WI| MN| MI, | IN, | IL,").
 * Meta's `CONTAIN` filter operator only matches one substring per clause and
 * multiple filtering clauses are AND'd, so there's no way to express "contains
 * ANY of these" server-side. Routes with a multi-keyword filter must omit the
 * name filter from the Meta request and call `matchesCampaignFilter` locally
 * on the results instead — see routes under /api/meta for the pattern.
 */
export function isMultiKeywordFilter(campaignFilter: string): boolean {
  return campaignFilter.includes('|');
}

export function matchesCampaignFilter(name: string, campaignFilter: string): boolean {
  if (!campaignFilter) return true;
  const needles = campaignFilter.split('|').map(s => s.trim()).filter(Boolean);
  if (needles.length === 0) return true;
  const haystack = name.toLowerCase();
  return needles.some(n => haystack.includes(n.toLowerCase()));
}

/**
 * Resolves a Meta `actions[]` array (from any insights response) down to a
 * single "results" count. Pixel-based leads take priority over onsite leads
 * over a generic 'lead' action, mirroring how Meta's own Ads Manager reports
 * results for lead-gen campaigns. Shared by the creatives and asset-breakdown
 * routes and the DB sync module so cached-mode numbers match live-mode
 * byte-for-byte. (DashboardClient.tsx has its own inline copies of this same
 * chain — those are browser-side, hitting our routes rather than Meta
 * directly, so they're intentionally left as-is rather than merged here.)
 */
export function resolveResultsFromActions(actions?: { action_type: string; value: string }[]): number {
  if (!actions) return 0;
  const m: Record<string, number> = {};
  for (const a of actions) m[a.action_type] = parseInt(a.value || '0', 10);
  const pixel = m['offsite_conversion.fb_pixel_lead'] || 0;
  const onsite = m['onsite_conversion.lead_grouped'] || 0;
  if (pixel > 0) return pixel;
  if (onsite > 0) return onsite;
  return m['lead'] || 0;
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
