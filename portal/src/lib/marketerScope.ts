// Agency-wide scope for the marketer module: every active client at once,
// their ad accounts, and a persisted campaign -> client attribution so
// cross-account queries can group Meta rows back to a location.
//
// Why a persisted table (marketer_campaign_client) instead of applying
// matchesCampaignFilter() at read time: the marketer pages join thousands
// of daily rows across ~13 accounts to ~90 clients; doing the pipe-
// delimited keyword match in JS on every request would mean pulling every
// campaign name into memory per request. Recomputing once after each
// entity sync (and on scope edits) makes attribution a plain SQL join.
import { query, pool } from './db';
import { getAdminClientMetaScope, matchesCampaignFilter } from './meta';
import { brandGroup } from './grouping';
import { parseOfferFromCampaignName } from './offers';

export interface MarketerClient {
  id: string;
  name: string;
  active: boolean;
  isRollup: boolean;
  adAccountIds: string[];        // resolved (empty in DB => every agency account)
  campaignFilter: string;
  marketingType: string;
  offer: string;
  coachName: string;
  locationAddress: string;
  lat: number | null;
  lng: number | null;
  geocodeError: string | null;
  sortOrder: number;
  brand: string;
  // Where this client's Leads KPI comes from (same setting as its dashboard).
  leadsSource: 'meta' | 'sheet' | 'ghl';
  sheetId: string;
  sheetTab: string;
  // GHL bookings source (token itself is never loaded here — see scorecard.ts).
  hasGhlToken: boolean;
  ghlLocationId: string;
  ghlLeadsTag: string;
  bookingCalendar: { name: string; platform: string; link: string } | null;
}

export interface MarketerScope {
  clients: MarketerClient[];           // active only, unless loaded with includeInactive
  locationClients: MarketerClient[];   // active, not rollup
  rollups: MarketerClient[];           // active rollups
  accountIds: string[];
  accountNameById: Map<string, string>;
  clientById: Map<string, MarketerClient>;
}

interface ClientDbRow {
  id: string; name: string; active: boolean; is_rollup: boolean; ad_account_ids: string[] | null; campaign_filter: string;
  marketing_type: string; offer: string; coach_name: string; location_address: string;
  location_lat: number | null; location_lng: number | null; geocode_error: string | null; sort_order: number;
  has_ghl_token: boolean; ghl_location_id: string; ghl_leads_tag: string;
  booking_calendar_name: string; booking_platform: string; booking_calendar_link: string;
  leads_source: string; sheet_id: string; sheet_tab: string;
}

async function loadAgencyAccounts(): Promise<{ ids: string[]; nameById: Map<string, string> }> {
  const rows = await query<{ account_ids: string[] | null; accounts_json: { id: string; name?: string }[] | null }>(
    `SELECT account_ids, accounts_json FROM agency_bm_connections`
  );
  const nameById = new Map<string, string>();
  const ids = new Set<string>();
  for (const r of rows) {
    for (const id of r.account_ids || []) ids.add(id);
    for (const a of r.accounts_json || []) if (a.id) nameById.set(a.id, a.name || '');
  }
  return { ids: Array.from(ids), nameById };
}

/**
 * Every active client (default) or every client ever (includeInactive —
 * the asset library's "all campaigns ever run" view and attribution).
 * locationClients / rollups are always the ACTIVE subsets.
 */
export async function loadMarketerScope(opts: { includeInactive?: boolean } = {}): Promise<MarketerScope> {
  const [{ ids: agencyIds, nameById }, rows] = await Promise.all([
    loadAgencyAccounts(),
    query<ClientDbRow>(
      `SELECT id, name, active, is_rollup, ad_account_ids, campaign_filter, marketing_type, offer, coach_name,
              location_address, location_lat, location_lng, geocode_error, sort_order,
              (length(ghl_token_enc) > 0) AS has_ghl_token, ghl_location_id, ghl_leads_tag,
              booking_calendar_name, booking_platform, booking_calendar_link,
              leads_source, sheet_id, sheet_tab
       FROM clients WHERE ($1::boolean OR active = true)
       ORDER BY active DESC, sort_order ASC, name ASC`,
      [!!opts.includeInactive]
    ),
  ]);

  const clients: MarketerClient[] = [];
  for (const r of rows) {
    const scope = await getAdminClientMetaScope({ ad_account_ids: r.ad_account_ids, campaign_filter: r.campaign_filter }, agencyIds);
    clients.push({
      id: r.id,
      name: r.name,
      active: !!r.active,
      isRollup: !!r.is_rollup,
      adAccountIds: scope.accountIds,
      campaignFilter: scope.campaignFilter,
      marketingType: r.marketing_type || '',
      offer: r.offer || '',
      coachName: r.coach_name || '',
      locationAddress: r.location_address || '',
      lat: r.location_lat === null ? null : Number(r.location_lat),
      lng: r.location_lng === null ? null : Number(r.location_lng),
      geocodeError: r.geocode_error,
      sortOrder: Number(r.sort_order ?? 999),
      brand: brandGroup(r.name),
      leadsSource: r.leads_source === 'ghl' || r.leads_source === 'sheet' ? r.leads_source : 'meta',
      sheetId: r.sheet_id || '',
      sheetTab: r.sheet_tab || '',
      hasGhlToken: !!r.has_ghl_token,
      ghlLocationId: r.ghl_location_id || '',
      ghlLeadsTag: r.ghl_leads_tag || '',
      bookingCalendar: r.booking_calendar_name
        ? { name: r.booking_calendar_name, platform: r.booking_platform || '', link: r.booking_calendar_link || '' }
        : null,
    });
  }

  const accountIds = Array.from(new Set(clients.flatMap(c => c.adAccountIds)));
  return {
    clients,
    locationClients: clients.filter(c => c.active && !c.isRollup),
    rollups: clients.filter(c => c.active && c.isRollup),
    accountIds,
    accountNameById: nameById,
    clientById: new Map(clients.map(c => [c.id, c])),
  };
}

// How specific a client's filter match is for a campaign name: the length
// of the longest matching keyword. 0 = the client sees the whole account
// (blank filter or `unfiltered:<acct>` segment), which is the least
// specific possible match. Used to pick is_primary among several matching
// location clients (e.g. "Alloy Naperville" vs "Alloy North Naperville").
function matchSpecificity(name: string, campaignFilter: string): number {
  if (!campaignFilter) return 0;
  const hay = name.toLowerCase();
  let best = 0;
  for (const seg of campaignFilter.split('|')) {
    const s = seg.trim();
    if (!s || s.startsWith('unfiltered:')) continue;
    if (hay.includes(s.toLowerCase()) && s.length > best) best = s.length;
  }
  return best;
}

/**
 * Recomputes marketer_campaign_client for one account (or every scoped
 * account when omitted). Safe to call after every entity sync — a few
 * thousand campaigns x ~90 clients is trivial in memory.
 */
export async function refreshCampaignAttribution(accountId?: string): Promise<{ accounts: number; rows: number }> {
  // Inactive clients are attributed too (the asset library's "all campaigns
  // ever run" view needs their names); active clients always win is_primary.
  const scope = await loadMarketerScope({ includeInactive: true });
  const accountIds = accountId ? [accountId] : scope.accountIds;
  let total = 0;

  for (const acct of accountIds) {
    const clientsOnAccount = scope.clients.filter(c => c.adAccountIds.includes(acct));
    const campaigns = await query<{ entity_id: string; name: string; offer_token: string | null }>(
      `SELECT entity_id, name, offer_token FROM meta_entities WHERE account_id = $1 AND level = 'campaign'`,
      [acct]
    );

    // Re-derive offer tokens from names (the entity sync only stamps rows it
    // touches, and the parser's vocabulary grows). Only rows whose parsed
    // value differs are written; manual overrides live in
    // campaign_offer_overrides and are untouched.
    const tokenIds: string[] = [];
    const tokenVals: string[] = [];
    for (const c of campaigns) {
      const t = parseOfferFromCampaignName(c.name || '');
      if (t && t !== c.offer_token) { tokenIds.push(c.entity_id); tokenVals.push(t); }
    }
    for (let i = 0; i < tokenIds.length; i += 2000) {
      await query(
        `UPDATE meta_entities m SET offer_token = t.offer_token
         FROM unnest($2::text[], $3::text[]) AS t(entity_id, offer_token)
         WHERE m.account_id = $1 AND m.level = 'campaign' AND m.entity_id = t.entity_id`,
        [acct, tokenIds.slice(i, i + 2000), tokenVals.slice(i, i + 2000)]
      );
    }

    const outCampaign: string[] = [];
    const outClient: string[] = [];
    const outPrimary: boolean[] = [];

    for (const camp of campaigns) {
      const matches = clientsOnAccount.filter(c => matchesCampaignFilter(camp.name, c.campaignFilter, acct));
      if (matches.length === 0) continue;
      // Primary = active before inactive, then the most specific non-rollup
      // match; ties broken by the narrowest account scope, then name.
      const candidates = matches.filter(c => !c.isRollup);
      let primaryId: string | null = null;
      if (candidates.length > 0) {
        candidates.sort((a, b) =>
          Number(b.active) - Number(a.active)
          || matchSpecificity(camp.name, b.campaignFilter) - matchSpecificity(camp.name, a.campaignFilter)
          || a.adAccountIds.length - b.adAccountIds.length
          || a.name.localeCompare(b.name));
        primaryId = candidates[0].id;
      }
      for (const c of matches) {
        outCampaign.push(camp.entity_id);
        outClient.push(c.id);
        outPrimary.push(c.id === primaryId);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM marketer_campaign_client WHERE account_id = $1`, [acct]);
      const BATCH = 2000;
      for (let i = 0; i < outCampaign.length; i += BATCH) {
        await client.query(
          `INSERT INTO marketer_campaign_client (account_id, campaign_id, client_id, is_primary, computed_at)
           SELECT $1, campaign_id, client_id::uuid, is_primary, now()
           FROM unnest($2::text[], $3::text[], $4::boolean[]) AS t(campaign_id, client_id, is_primary)
           ON CONFLICT (account_id, campaign_id, client_id) DO UPDATE SET is_primary = EXCLUDED.is_primary, computed_at = now()`,
          [acct, outCampaign.slice(i, i + BATCH), outClient.slice(i, i + BATCH), outPrimary.slice(i, i + BATCH)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    total += outCampaign.length;
  }

  return { accounts: accountIds.length, rows: total };
}
