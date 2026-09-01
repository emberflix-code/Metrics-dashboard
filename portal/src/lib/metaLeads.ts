import { query } from './db';
import { decrypt } from './crypto';
import { matchesCampaignFilter } from './meta';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface MetaLead {
  id: string;
  createdTime: string;   // ISO-8601, as Meta returns it
  name: string;
  email: string;
  phone: string;
  campaignName: string;
}

interface GraphError { message?: string; code?: number; error_subcode?: number }

/** The slice of Meta's ad-creative shape we read form IDs out of. */
interface CallToAction { value?: { lead_gen_form_id?: string | number } }
interface AdCreative {
  object_story_spec?: {
    link_data?: { call_to_action?: CallToAction };
    video_data?: { call_to_action?: CallToAction };
  };
  asset_feed_spec?: { call_to_actions?: CallToAction[] };
}
interface RawLead {
  id: string;
  created_time: string;
  field_data?: { name?: string; values?: string[] }[];
}

/**
 * Meta instant-form ("lead gen") LEAD CONTENT.
 *
 * Two different tokens are needed and they are not interchangeable:
 *
 *  - Ad-account token (agency_bm_connections, ads_read): reads insights and
 *    walks campaign -> ad -> creative to discover WHICH instant form an ad
 *    points at. Cannot read the leads themselves.
 *  - Page token (agency_page_token, needs leads_retrieval + a role on the
 *    Page that owns the form): reads the actual submissions. Asking the
 *    ad-account token for /{form}/leads returns code 100/subcode 33 — Meta
 *    reports the form as simply nonexistent rather than forbidden.
 *
 * Form IDs are not on a single predictable field: a plain link/video ad keeps
 * the CTA on object_story_spec, while a Dynamic Creative / Advantage+ ad keeps
 * it on asset_feed_spec.call_to_actions[]. Both shapes are checked.
 */

/** YYYY-MM-DD for an absolute timestamp, in the given IANA timezone. */
export function dayInTimezone(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return (iso || '').slice(0, 10);
  }
}

/** Pulls every lead_gen_form_id reachable from the client's campaigns in range. */
async function discoverFormIds(
  adToken: string,
  accountIds: string[],
  campaignFilter: string,
  since: string,
  until: string
): Promise<Map<string, string>> {
  const formToCampaign = new Map<string, string>();

  for (const accountId of accountIds) {
    const insUrl = new URL(`${GRAPH}/act_${accountId}/insights`);
    insUrl.searchParams.set('access_token', adToken);
    insUrl.searchParams.set('level', 'campaign');
    insUrl.searchParams.set('fields', 'campaign_id,campaign_name');
    insUrl.searchParams.set('time_range', JSON.stringify({ since, until }));
    insUrl.searchParams.set('limit', '200');

    let insJson: { data?: { campaign_id: string; campaign_name: string }[]; error?: GraphError };
    try {
      insJson = await (await fetch(insUrl.toString())).json();
    } catch {
      continue; // one bad account shouldn't kill the whole modal
    }
    if (insJson.error) continue;

    for (const row of insJson.data || []) {
      if (!matchesCampaignFilter(row.campaign_name || '', campaignFilter)) continue;

      const adsUrl = new URL(`${GRAPH}/${row.campaign_id}/ads`);
      adsUrl.searchParams.set('access_token', adToken);
      adsUrl.searchParams.set('fields', 'id,creative{object_story_spec,asset_feed_spec}');
      adsUrl.searchParams.set('limit', '100');

      let adsJson: { data?: { id: string; creative?: AdCreative }[]; error?: GraphError };
      try {
        adsJson = await (await fetch(adsUrl.toString())).json();
      } catch {
        continue;
      }
      if (adsJson.error) continue;

      for (const ad of adsJson.data || []) {
        const creative: AdCreative = ad.creative || {};
        const ctas = [
          ...(creative.asset_feed_spec?.call_to_actions || []),
          creative.object_story_spec?.link_data?.call_to_action,
          creative.object_story_spec?.video_data?.call_to_action,
        ].filter(Boolean);
        for (const cta of ctas) {
          const formId = cta?.value?.lead_gen_form_id;
          // First campaign to claim a form wins: one form can be shared by
          // several ads, and we only need a label for the modal row.
          if (formId && !formToCampaign.has(String(formId))) {
            formToCampaign.set(String(formId), row.campaign_name || '');
          }
        }
      }
    }
  }
  return formToCampaign;
}

/** Flattens Meta's field_data name/values pairs into the fields we display. */
function readFieldData(fieldData: { name?: string; values?: string[] }[] | undefined) {
  const map: Record<string, string> = {};
  for (const f of fieldData || []) {
    if (f.name) map[f.name] = (f.values || []).join(', ');
  }
  const name = map.full_name
    || [map.first_name, map.last_name].filter(Boolean).join(' ').trim();
  return {
    name: name || '—',
    email: map.email || '',
    phone: map.phone_number || map.phone || '',
  };
}

export type LeadFetchResult =
  | { ok: true; leads: MetaLead[] }
  | { ok: false; reason: 'no_page_token' | 'no_ad_token' | 'no_forms' | 'no_access'; message: string };

/**
 * Returns the leads behind a client's Meta Leads count for [since, until].
 *
 * `since`/`until` are plain YYYY-MM-DD days in the ad account's timezone, the
 * same bucketing the KPI card itself uses. Meta returns created_time as an
 * absolute timestamp, so we compare on the date portion after shifting into
 * that timezone — otherwise a late-evening lead lands on the wrong day and the
 * list disagrees with the number that opened it.
 */
export async function fetchMetaLeads(opts: {
  accountIds: string[];
  campaignFilter: string;
  since: string;
  until: string;
  timezone: string;
}): Promise<LeadFetchResult> {
  const { accountIds, campaignFilter, since, until, timezone } = opts;

  const [pageRow] = await query<{ token_enc: string | null }>(
    `SELECT token_enc FROM agency_page_token WHERE id = 1`
  );
  if (!pageRow?.token_enc) {
    return { ok: false, reason: 'no_page_token', message: 'No Page token configured in Settings.' };
  }
  const pageToken = decrypt(pageRow.token_enc);

  const [bmRow] = await query<{ token_enc: string }>(
    `SELECT token_enc FROM agency_bm_connections WHERE $1 && account_ids LIMIT 1`,
    [accountIds]
  );
  if (!bmRow) {
    return { ok: false, reason: 'no_ad_token', message: 'No Business Manager connection covers this account.' };
  }
  const adToken = decrypt(bmRow.token_enc);

  const formToCampaign = await discoverFormIds(adToken, accountIds, campaignFilter, since, until);
  if (formToCampaign.size === 0) {
    return { ok: false, reason: 'no_forms', message: 'No Meta instant forms found on campaigns in this date range.' };
  }

  const leads: MetaLead[] = [];
  const seen = new Set<string>();
  let sawAccessError = false;
  let lastAccessMessage = '';

  for (const [formId, campaignName] of Array.from(formToCampaign.entries())) {
    // Meta paginates leads; walk until the range is covered. Leads come back
    // newest-first, so we can stop once we are older than `since`.
    const first = new URL(`${GRAPH}/${formId}/leads`);
    first.searchParams.set('access_token', pageToken);
    first.searchParams.set('fields', 'id,created_time,field_data');
    first.searchParams.set('limit', '100');
    let next: string | null = first.toString();

    let guard = 20; // hard page cap so a huge form cannot hang the request
    while (next && guard-- > 0) {
      let json: { data?: RawLead[]; paging?: { next?: string }; error?: GraphError };
      try {
        json = await (await fetch(next)).json();
      } catch {
        break;
      }
      if (json.error) {
        // 100/33 and 200 both mean "this token has no role on the owning Page".
        if (json.error.code === 100 || json.error.code === 200) {
          sawAccessError = true;
          lastAccessMessage = json.error.message || '';
        }
        break;
      }

      let reachedOlder = false;
      for (const raw of json.data || []) {
        const day = dayInTimezone(raw.created_time, timezone);
        if (day > until) continue;      // newer than the window — keep paging
        if (day < since) { reachedOlder = true; continue; }
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        const { name, email, phone } = readFieldData(raw.field_data);
        leads.push({ id: raw.id, createdTime: raw.created_time, name, email, phone, campaignName });
      }
      if (reachedOlder) break;
      next = json.paging?.next || null;
    }
  }

  if (leads.length === 0 && sawAccessError) {
    return {
      ok: false,
      reason: 'no_access',
      message: lastAccessMessage || 'The Page token cannot read the leads for this form.',
    };
  }

  leads.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
  return { ok: true, leads };
}
