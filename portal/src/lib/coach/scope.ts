// Which clients a coach-board session may see. Coaches: only clients whose
// coach_name lists the coach (comma-separated free text, e.g. "Chad
// Reihbrandt, Brad Meyer"), matched case-insensitively on the whole name —
// "Brad" never matches "Brad Meyer". Admins: every client, optionally
// narrowed to one coach. A coach with no coach_name sees nothing (never all).
import { query } from '../db';
import type { CoachContext } from '../coachAuth';

export interface CoachClient {
  id: string;
  name: string;
  active: boolean;
  isRollup: boolean;
  marketingType: string;
  offer: string;
  /** Sheet "Marketing Offer (Text)" — the real offer when `offer` is "Unique Offer ...". */
  offerDetails: string;
  /** Sheet "Launch Date" as YYYY-MM-DD, '' when unknown. */
  launchDate: string;
  coachName: string;
  contactName: string;
  locationAddress: string;
  sortOrder: number;
  leadsSource: string;
  dataSource: string;
  adAccountIds: string[];
  campaignFilter: string;
  googleDataSource: string;
  googleCustomerIds: string[];
  googleCampaignFilter: string;
  googleSheetTab: string;
  hasGhlToken: boolean;
  showCreativesV3: boolean;
  showBookings: boolean;
  /** CPA card on AND a CPA sheet tab configured (what the dashboard needs to show it). */
  cpaEnabled: boolean;
  ltvEnabled: boolean;
}

interface ClientRow {
  id: string; name: string; active: boolean; is_rollup: boolean; marketing_type: string; offer: string; offer_details: string; launch_date: string | null;
  coach_name: string; client_contact_name: string; location_address: string; sort_order: number;
  leads_source: string; data_source: string; ad_account_ids: string[] | null; campaign_filter: string;
  google_data_source: string; google_ads_customer_ids: string[] | null; google_campaign_filter: string;
  google_sheet_tab: string; has_ghl_token: boolean;
  show_creatives_v3: boolean; show_bookings: boolean; cpa_enabled: boolean; ltv_enabled: boolean;
}

// $1 = coach name. True when any comma-separated entry equals it (trimmed, case-insensitive).
const COACH_MATCH_SQL = `EXISTS (SELECT 1 FROM unnest(string_to_array(c.coach_name, ',')) AS n
                                 WHERE lower(btrim(n)) = lower(btrim($1)))`;

/** Coach name to filter by: the coach's own name, or an admin's optional filter ('' = all). */
function effectiveCoach(ctx: CoachContext, adminCoachFilter?: string): string | null {
  if (!ctx.isAdmin) return ctx.coachName;
  const f = (adminCoachFilter || '').trim();
  return f || null;
}

export async function loadCoachClients(ctx: CoachContext, opts: { adminCoachFilter?: string; includeInactive?: boolean } = {}): Promise<CoachClient[]> {
  const coach = effectiveCoach(ctx, opts.adminCoachFilter);
  if (coach === '') return [];
  const params: unknown[] = [];
  const where: string[] = [];
  if (coach !== null) { params.push(coach); where.push(COACH_MATCH_SQL); }
  if (!opts.includeInactive) where.push('c.active = true');
  const rows = await query<ClientRow>(
    `SELECT c.id, c.name, c.active, c.is_rollup, c.marketing_type, c.offer, c.offer_details, to_char(c.launch_date, 'YYYY-MM-DD') AS launch_date, c.coach_name, c.client_contact_name,
            c.location_address, c.sort_order, c.leads_source, c.data_source, c.ad_account_ids, c.campaign_filter,
            c.google_data_source, c.google_ads_customer_ids, c.google_campaign_filter, c.google_sheet_tab,
            (length(c.ghl_token_enc) > 0 AND length(c.ghl_location_id) > 0) AS has_ghl_token,
            c.show_creatives_v3, c.show_bookings,
            (c.show_cpa AND c.cpa_sheet_id <> '' AND c.cpa_sheet_tab <> '') AS cpa_enabled,
            (c.show_ltv AND c.cpa_sheet_id <> '' AND c.cpa_sheet_tab <> '') AS ltv_enabled
     FROM clients c
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.sort_order ASC, c.name ASC`,
    params
  );
  return rows.map(r => ({
    id: r.id, name: r.name, active: r.active, isRollup: r.is_rollup,
    marketingType: r.marketing_type || '', offer: r.offer || '', offerDetails: r.offer_details || '', launchDate: r.launch_date || '', coachName: r.coach_name || '',
    contactName: r.client_contact_name || '', locationAddress: r.location_address || '', sortOrder: r.sort_order,
    leadsSource: r.leads_source || 'meta', dataSource: r.data_source || 'live',
    adAccountIds: r.ad_account_ids || [], campaignFilter: r.campaign_filter || '',
    googleDataSource: r.google_data_source || 'sheet', googleCustomerIds: r.google_ads_customer_ids || [],
    googleCampaignFilter: r.google_campaign_filter || '', googleSheetTab: r.google_sheet_tab || '',
    hasGhlToken: !!r.has_ghl_token,
    showCreativesV3: !!r.show_creatives_v3, showBookings: !!r.show_bookings,
    cpaEnabled: !!r.cpa_enabled, ltvEnabled: !!r.ltv_enabled,
  }));
}

/** Whether this session may act on the client (open its dashboard, copy its link). */
export async function assertCoachOwnsClient(ctx: CoachContext, clientId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return false;
  if (ctx.isAdmin) {
    const rows = await query(`SELECT 1 FROM clients c WHERE c.id = $1`, [clientId]);
    return rows.length > 0;
  }
  if (!ctx.coachName) return false;
  const rows = await query(`SELECT 1 FROM clients c WHERE c.id = $2 AND ${COACH_MATCH_SQL}`, [ctx.coachName, clientId]);
  return rows.length > 0;
}

/** Distinct coach names across clients.coach_name (for the admin filter + coach setup). */
export async function listCoachNames(): Promise<string[]> {
  const rows = await query<{ n: string }>(
    `SELECT DISTINCT btrim(n) AS n FROM clients, unnest(string_to_array(coach_name, ',')) AS n
     WHERE btrim(n) <> '' ORDER BY 1`
  );
  return rows.map(r => r.n);
}
