/**
 * Page-access audit for the "Show Meta lead names" feature.
 *
 * Instant-form lead CONTENT is readable only with a token holding a role on
 * the PAGE that owns the form — the ads_read BM tokens cannot see it (they get
 * code 100/subcode 33, which misleadingly reports the form as nonexistent).
 * This script reports, per client, exactly which Page IDs the agency Page token
 * still needs access to, so the gaps can be chased deliberately instead of
 * being discovered one empty modal at a time.
 *
 * Run:
 *   railway run npx tsx portal/scripts/page-access-audit.ts             # all meta clients
 *   railway run npx tsx portal/scripts/page-access-audit.ts "Client"    # one client
 *   railway run npx tsx portal/scripts/page-access-audit.ts --ready     # only fully-covered
 *   railway run npx tsx portal/scripts/page-access-audit.ts --csv       # CSV for a checklist
 *
 * Read-only: performs GETs against the Graph API and the DB. Writes nothing.
 *
 * Note on Page names: we deliberately do NOT try to resolve them. Naming a Page
 * requires a role on it, which is the very thing we are auditing for — so for
 * uncovered Pages the lookup always fails. Campaign names are reported instead;
 * they identify the client far better than a bare numeric ID anyway.
 */
import { Pool } from 'pg';
import { decrypt } from '../src/lib/crypto';
import { matchesCampaignFilter } from '../src/lib/meta';

const GRAPH = 'https://graph.facebook.com/v21.0';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const args = process.argv.slice(2);
const CSV = args.includes('--csv');
const READY_ONLY = args.includes('--ready');
const CLIENT_NAME = args.find(a => !a.startsWith('--'));

interface PageUse { pageId: string; campaigns: Set<string>; hasForm: boolean }

async function get(path: string, params: Record<string, string>) {
  const u = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  try {
    return await (await fetch(u.toString())).json() as Record<string, any>;
  } catch (e) {
    return { error: { message: e instanceof Error ? e.message : 'fetch failed' } };
  }
}

async function main() {
  // What the agency Page token can already reach.
  const [pt] = (await pool.query<{ token_enc: string | null }>(
    `SELECT token_enc FROM agency_page_token WHERE id = 1`)).rows;
  const covered = new Map<string, string>(); // pageId -> name
  const leadCapable = new Set<string>();     // pages that actually grant MANAGE_LEADS
  if (pt?.token_enc) {
    const r = await get('me/accounts', { access_token: decrypt(pt.token_enc), fields: 'id,name,tasks', limit: '200' });
    for (const p of r.data || []) {
      covered.set(p.id, p.name || '');
      // ADVERTISE alone is enough for the image fallback but NOT for reading
      // leads — Meta gates lead retrieval behind the Leads task specifically.
      if ((p.tasks || []).includes('MANAGE_LEADS')) leadCapable.add(p.id);
    }
  }

  const clients = (await pool.query<{ name: string; ad_account_ids: string[]; campaign_filter: string; show_meta_lead_names: boolean }>(
    `SELECT name, ad_account_ids, campaign_filter, show_meta_lead_names
     FROM clients
     WHERE active AND leads_source = 'meta'
       AND ad_account_ids IS NOT NULL AND array_length(ad_account_ids, 1) > 0
       ${CLIENT_NAME ? 'AND name = $1' : ''}
     ORDER BY name`, CLIENT_NAME ? [CLIENT_NAME] : [])).rows;

  if (!CSV) {
    console.log(`\nPage-access audit — ${clients.length} client(s) with leads_source='meta'`);
    console.log(`Page token reaches ${covered.size} page(s), ${leadCapable.size} with Leads access\n`);
  } else {
    console.log('client,page_id,campaigns,status,toggle_on');
  }

  const tokenCache = new Map<string, string>();
  async function tokenFor(accountIds: string[]): Promise<string | null> {
    const key = accountIds.join(',');
    if (tokenCache.has(key)) return tokenCache.get(key)!;
    const [bm] = (await pool.query<{ token_enc: string }>(
      `SELECT token_enc FROM agency_bm_connections WHERE $1 && account_ids LIMIT 1`, [accountIds])).rows;
    if (!bm) return null;
    const t = decrypt(bm.token_enc);
    tokenCache.set(key, t);
    return t;
  }

  const summary: { name: string; total: number; ready: number; toggle: boolean }[] = [];
  // Graph failures during the ad walk. Reported at the end rather than
  // discarded — otherwise a rate-limited client is indistinguishable from one
  // that genuinely has no instant-form ads.
  const fetchWarnings: string[] = [];

  for (const c of clients) {
    const adToken = await tokenFor(c.ad_account_ids);
    if (!adToken) continue;

    // Only look at ads that actually carry an instant form — a Page with no
    // lead-gen ad on it needs no grant, and listing it would pad the ask.
    const pages = new Map<string, PageUse>();
    for (const acct of c.ad_account_ids) {
      // Must paginate: a single unpaginated page of ads silently truncates
      // accounts with many ads, and the ad carrying the instant form is often
      // NOT in the first page — CycleBar Redmond reported "no instant-form
      // ads" at limit=150 while auditing correctly as READY on its own.
      const first = new URL(`${GRAPH}/act_${acct}/ads`);
      first.searchParams.set('access_token', adToken);
      first.searchParams.set('fields', 'name,campaign{name},creative{object_story_spec,asset_feed_spec}');
      // limit=200 with these nested creative fields trips Meta's "Please reduce
      // the amount of data you're asking for" (code 1) on real accounts. 50 is
      // the largest value observed to survive it.
      first.searchParams.set('limit', '50');
      let next: string | null = first.toString();
      let guard = 60;
      const allAds: Record<string, any>[] = [];
      while (next && guard-- > 0) {
        let page: Record<string, any>;
        try {
          page = await (await fetch(next)).json();
        } catch (e) {
          fetchWarnings.push(`${c.name} / act_${acct}: ${e instanceof Error ? e.message : 'fetch failed'}`);
          break;
        }
        if (page.error) {
          // Never swallow this: an errored walk looks identical to "this client
          // has no instant-form ads", which would silently under-report the
          // very gaps this audit exists to find.
          fetchWarnings.push(`${c.name} / act_${acct}: ${page.error.message}`);
          break;
        }
        allAds.push(...(page.data || []));
        next = page.paging?.next || null;
      }
      for (const ad of allAds) {
        const campaignName = ad.campaign?.name || '';
        if (!matchesCampaignFilter(campaignName, c.campaign_filter)) continue;
        const cr = ad.creative || {};
        const pageId = cr.object_story_spec?.page_id;
        if (!pageId) continue;
        const ctas = [
          ...(cr.asset_feed_spec?.call_to_actions || []),
          cr.object_story_spec?.link_data?.call_to_action,
          cr.object_story_spec?.video_data?.call_to_action,
        ].filter(Boolean);
        const hasForm = ctas.some((x: Record<string, any>) => x?.value?.lead_gen_form_id);
        if (!pages.has(pageId)) pages.set(pageId, { pageId, campaigns: new Set(), hasForm: false });
        const e = pages.get(pageId)!;
        if (campaignName) e.campaigns.add(campaignName);
        if (hasForm) e.hasForm = true;
      }
    }

    const formPages = Array.from(pages.values()).filter(p => p.hasForm);
    const ready = formPages.filter(p => leadCapable.has(p.pageId));
    const gaps = formPages.filter(p => !leadCapable.has(p.pageId));
    summary.push({ name: c.name, total: formPages.length, ready: ready.length, toggle: c.show_meta_lead_names });

    if (READY_ONLY && gaps.length > 0) continue;

    if (CSV) {
      for (const p of formPages) {
        const status = leadCapable.has(p.pageId) ? 'READY'
          : covered.has(p.pageId) ? 'NEEDS_LEADS_ACCESS' : 'NEEDS_PAGE_ASSIGNMENT';
        const camps = Array.from(p.campaigns).slice(0, 2).join('; ').replace(/"/g, "'");
        console.log(`"${c.name}",${p.pageId},"${camps}",${status},${c.show_meta_lead_names}`);
      }
      continue;
    }

    if (formPages.length === 0) {
      const errored = fetchWarnings.some(w => w.startsWith(`${c.name} /`));
      console.log(`${c.name}\n   ${errored
        ? 'INCONCLUSIVE — the ad walk errored (see warnings below), not a confirmed absence'
        : 'no instant-form ads found — nothing to grant'}\n`);
      continue;
    }

    const verdict = gaps.length === 0 ? 'READY' : `${ready.length}/${formPages.length} pages ready`;
    console.log(`${c.name}   [${verdict}]${c.show_meta_lead_names ? '  (toggle ON)' : ''}`);
    for (const p of gaps) {
      // A Page the token can see but without MANAGE_LEADS is a much smaller
      // ask than one it cannot see at all — call that out explicitly.
      const partial = covered.has(p.pageId);
      console.log(`   NEEDS ${partial ? 'LEADS ACCESS' : 'ASSIGNMENT  '}  page ${p.pageId}`);
      for (const cn of Array.from(p.campaigns).slice(0, 2)) console.log(`        via campaign: ${cn}`);
    }
    if (gaps.length === 0) console.log(`   all ${formPages.length} form page(s) readable`);
    console.log();
  }

  if (!CSV) {
    const readyClients = summary.filter(s => s.total > 0 && s.ready === s.total);
    const blocked = summary.filter(s => s.total > 0 && s.ready < s.total);
    console.log('─'.repeat(64));
    console.log(`READY to enable  : ${readyClients.length}  ${readyClients.map(s => s.name).join(', ') || '—'}`);
    console.log(`Needs Page grants: ${blocked.length}`);
    const wrong = summary.filter(s => s.toggle && s.ready < s.total);
    if (wrong.length) {
      console.log(`\nWARNING — toggle is ON but pages are not fully granted (modal will show "not available"):`);
      for (const s of wrong) console.log(`   ${s.name}  (${s.ready}/${s.total})`);
    }
    if (fetchWarnings.length) {
      console.log(`\nGRAPH ERRORS during the ad walk — these clients are INCONCLUSIVE, not clean:`);
      for (const w of fetchWarnings.slice(0, 20)) console.log(`   ${w}`);
      if (fetchWarnings.length > 20) console.log(`   ... +${fetchWarnings.length - 20} more`);
    }
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
