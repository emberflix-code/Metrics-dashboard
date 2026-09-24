// Alerts feed: the marketer's daily work queue. Every rule is deterministic
// and reads cached tables only; thresholds are deliberately conservative
// (same posture as the client dashboard's Insights tab) so the list stays
// short enough to act on. Keys are stable per finding so a dismissal
// survives recomputation.
import { query } from '@/lib/db';
import { loadMarketerScope } from '@/lib/marketerScope';
import { addDaysToISODate } from '@/lib/dateRange';
import { judgeCopyAgainstOffer, parseOfferFromAdName, parseCityFromCampaignName, OFFER_EXPECTATIONS } from '@/lib/offers';
import { loadCampaignStats, cplOf } from './campaignStats';
import { detectFatigue } from './fatigue';
import { buildTargetingReport } from './targeting';
import { adsManagerAdUrl, adsManagerAdsetUrl, adsManagerCampaignUrl } from '@/app/(marketer)/marketer/_components/format';

export type AlertKind =
  | 'zero_lead_spend' | 'cpl_spike' | 'overlap_high' | 'off_club' | 'broad_targeting'
  | 'copy_offer_mismatch' | 'greeting_city_mismatch' | 'unattributed_campaign' | 'stale_sync' | 'creative_fatigue' | 'club_not_geocoded';
export type AlertSeverity = 'high' | 'medium' | 'low';

export interface Alert {
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  clientId: string | null;
  clientName: string | null;
  accountId: string | null;
  level: 'campaign' | 'adset' | 'ad' | 'asset' | 'client' | 'account' | 'pair';
  entityId: string | null;
  metrics: Record<string, number | string | null>;
  url: string | null;
  dismissed: boolean;
  snoozedUntil: string | null;
}

export const ZERO_LEAD_MIN_SPEND_7D = 150;
export const CPL_SPIKE_RATIO = 1.6;
export const CPL_SPIKE_MIN_BASE_LEADS = 5;
export const STALE_SYNC_HOURS = 36;

// Known dual-branding cases from the Sep 2026 Omega audit that LOOK like a
// greeting/city mismatch but are the club's own naming.
const GREETING_ALLOW: [string, string][] = [
  ['ponte vedra', 'sawgrass'],
  ['murrysville', 'monroeville'],
];

const rank = (s: AlertSeverity) => s === 'high' ? 2 : s === 'medium' ? 1 : 0;

export interface AlertsResult {
  until: string;
  windows: { last7: { since: string; until: string }; prior28: { since: string; until: string } };
  alerts: Alert[];
  counts: Record<AlertKind, number>;
  generatedAt: string;
}

export async function buildAlerts(f: { until: string; includeDismissed?: boolean; kinds?: AlertKind[]; clientIds?: string[]; brand?: string }): Promise<AlertsResult> {
  const scope = await loadMarketerScope();
  const last7 = { since: addDaysToISODate(f.until, -6), until: f.until };
  const prior28 = { since: addDaysToISODate(f.until, -34), until: addDaysToISODate(f.until, -7) };
  const wanted = (k: AlertKind) => !f.kinds || f.kinds.includes(k);
  const alerts: Alert[] = [];
  const clientName = (id: string | null) => (id ? scope.clientById.get(id)?.name ?? null : null);

  // ── Campaign-level: zero-lead spend, CPL spike, unattributed ─────────
  if (wanted('zero_lead_spend') || wanted('cpl_spike') || wanted('unattributed_campaign')) {
    const [recent, base] = await Promise.all([
      loadCampaignStats(scope.accountIds, last7.since, last7.until, { includeUnattributed: true }),
      loadCampaignStats(scope.accountIds, prior28.since, prior28.until, { includeUnattributed: true }),
    ]);
    const baseByKey = new Map(base.map(b => [`${b.accountId}:${b.campaignId}`, b]));
    for (const s of recent) {
      const key = `${s.accountId}:${s.campaignId}`;
      const isActive = s.status === 'ACTIVE';
      if (wanted('unattributed_campaign') && !s.clientId && s.spend > 0) {
        alerts.push({
          key: `unattributed_campaign:${key}`, kind: 'unattributed_campaign', severity: s.spend >= 500 ? 'medium' : 'low',
          title: `No location owns "${s.campaignName || s.campaignId}"`,
          detail: `Spent $${s.spend.toFixed(0)} in the last 7 days but no active client's campaign filter matches it. Fix the client's filter or mark the campaign.`,
          clientId: null, clientName: null, accountId: s.accountId, level: 'campaign', entityId: s.campaignId,
          metrics: { spend7d: s.spend, results7d: s.results }, url: adsManagerCampaignUrl(s.accountId, s.campaignId), dismissed: false, snoozedUntil: null,
        });
      }
      if (!isActive) continue;
      if (wanted('zero_lead_spend') && s.results === 0 && s.spend >= ZERO_LEAD_MIN_SPEND_7D) {
        alerts.push({
          key: `zero_lead_spend:${key}`, kind: 'zero_lead_spend', severity: s.spend >= 400 ? 'high' : 'medium',
          title: `$${s.spend.toFixed(0)} in 7 days, zero leads — ${s.campaignName || s.campaignId}`,
          detail: `Active campaign with no results since ${last7.since}. Check the lead form / pixel, the offer, and the creative.`,
          clientId: s.clientId, clientName: clientName(s.clientId), accountId: s.accountId, level: 'campaign', entityId: s.campaignId,
          metrics: { spend7d: s.spend, impressions7d: s.impressions, clicks7d: s.clicks }, url: adsManagerCampaignUrl(s.accountId, s.campaignId), dismissed: false, snoozedUntil: null,
        });
      }
      if (wanted('cpl_spike')) {
        const b = baseByKey.get(key);
        const cplNow = cplOf(s.spend, s.results);
        const cplBase = b ? cplOf(b.spend, b.results) : null;
        if (b && cplNow !== null && cplBase !== null && b.results >= CPL_SPIKE_MIN_BASE_LEADS && s.results >= 2 && cplNow >= cplBase * CPL_SPIKE_RATIO) {
          const ratio = cplNow / cplBase;
          alerts.push({
            key: `cpl_spike:${key}`, kind: 'cpl_spike', severity: ratio >= 2.5 ? 'high' : 'medium',
            title: `CPL up ${Math.round((ratio - 1) * 100)}% — ${s.campaignName || s.campaignId}`,
            detail: `$${cplNow.toFixed(2)} per lead over the last 7 days vs $${cplBase.toFixed(2)} over the prior 4 weeks (${b.results} leads baseline).`,
            clientId: s.clientId, clientName: clientName(s.clientId), accountId: s.accountId, level: 'campaign', entityId: s.campaignId,
            metrics: { cpl7d: cplNow, cplBase, spend7d: s.spend, results7d: s.results }, url: adsManagerCampaignUrl(s.accountId, s.campaignId), dismissed: false, snoozedUntil: null,
          });
        }
      }
    }
  }

  // ── Targeting: high overlaps, off-club, broad ────────────────────────
  if (wanted('overlap_high') || wanted('off_club') || wanted('broad_targeting')) {
    try {
      const report = await buildTargetingReport({ since: last7.since, until: last7.until, minScore: 0.2 });
      if (wanted('overlap_high')) {
        for (const p of report.pairs) {
          if (p.severity !== 'high' && !(p.severity === 'medium' && p.combinedSpend >= 500)) continue;
          const key = [`${p.a.accountId}:${p.a.adsetId}`, `${p.b.accountId}:${p.b.adsetId}`].sort().join('|');
          alerts.push({
            key: `overlap_high:${key}`, kind: 'overlap_high', severity: p.severity === 'high' ? 'high' : 'medium',
            title: `${Math.round(p.score * 100)}% radius overlap — ${p.a.clientName ?? p.a.adsetName} ↔ ${p.b.clientName ?? p.b.adsetName}`,
            detail: `${p.a.adsetName} (${p.a.offer}) and ${p.b.adsetName} (${p.b.offer}) are ${p.distanceKm.toFixed(1)} km apart with overlapping radii; $${p.combinedSpend.toFixed(0)} combined in 7 days${p.sameOffer ? ', same offer' : ''}.`,
            clientId: p.a.clientId, clientName: p.a.clientName, accountId: p.a.accountId, level: 'pair', entityId: key,
            metrics: { score: p.score, distanceKm: p.distanceKm, combinedSpend: p.combinedSpend, adsetA: p.a.adsetId, adsetB: p.b.adsetId },
            url: adsManagerAdsetUrl(p.a.accountId, p.a.adsetId), dismissed: false, snoozedUntil: null,
          });
        }
      }
      if (wanted('off_club')) {
        for (const o of report.offClub) {
          alerts.push({
            key: `off_club:${o.adset.accountId}:${o.adset.adsetId}`, kind: 'off_club', severity: o.distanceKm > 50 ? 'high' : 'medium',
            title: `Ad set centred ${o.distanceKm.toFixed(0)} km from its club — ${o.adset.adsetName}`,
            detail: `${o.adset.clientName ?? 'Client'}'s ad set targets a ${o.adset.radiusKm.toFixed(0)} km radius that doesn't cover the club address. Verify the pin or the client attribution.`,
            clientId: o.adset.clientId, clientName: o.adset.clientName, accountId: o.adset.accountId, level: 'adset', entityId: o.adset.adsetId,
            metrics: { distanceKm: o.distanceKm, radiusKm: o.adset.radiusKm, spend7d: o.adset.spend }, url: adsManagerAdsetUrl(o.adset.accountId, o.adset.adsetId), dismissed: false, snoozedUntil: null,
          });
        }
      }
      if (wanted('broad_targeting')) {
        for (const b of report.broad) {
          alerts.push({
            key: `broad_targeting:${b.accountId}:${b.adsetId}`, kind: 'broad_targeting', severity: b.spend >= 300 ? 'medium' : 'low',
            title: `Region/country-wide targeting — ${b.adsetName}`,
            detail: `${b.clientName ?? 'Client'} · ${b.campaignName}: targets ${b.kinds.join(', ')} with no radius; $${b.spend.toFixed(0)} in 7 days.`,
            clientId: null, clientName: b.clientName, accountId: b.accountId, level: 'adset', entityId: b.adsetId,
            metrics: { spend7d: b.spend }, url: adsManagerAdsetUrl(b.accountId, b.adsetId), dismissed: false, snoozedUntil: null,
          });
        }
      }
      if (wanted('club_not_geocoded')) {
        for (const c of report.unmapped.clientsWithoutGeocode) {
          alerts.push({
            key: `club_not_geocoded:${c.clientId}`, kind: 'club_not_geocoded', severity: 'low',
            title: `Club not on the map — ${c.name}`,
            detail: c.address ? `Address "${c.address}" could not be geocoded${c.error ? `: ${c.error}` : ''}.` : 'No address on file (set it via the marketing sheet sync or the client PATCH).',
            clientId: c.clientId, clientName: c.name, accountId: null, level: 'client', entityId: c.clientId, metrics: {}, url: null, dismissed: false, snoozedUntil: null,
          });
        }
      }
    } catch (err) {
      console.error('[MARKETER-ALERTS]', JSON.stringify({ step: 'targeting', error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // ── Copy consistency (ACTIVE ads with synced copy) ───────────────────
  if (wanted('copy_offer_mismatch') || wanted('greeting_city_mismatch')) {
    const ads = await query<{
      account_id: string; ad_id: string; ad_name: string; campaign_id: string | null; campaign_name: string | null; offer: string; client_id: string | null;
      bodies: { text: string }[]; titles: { text: string }[]; descriptions: { text: string }[];
    }>(
      `SELECT c.account_id, c.ad_id, e.name AS ad_name, e.campaign_id, e.campaign_name,
              COALESCE(o.offer, ce.offer_token, 'Unknown') AS offer, m.client_id,
              c.bodies, c.titles, c.descriptions
       FROM meta_ad_copy c
       JOIN meta_entities e ON e.account_id = c.account_id AND e.level = 'ad' AND e.entity_id = c.ad_id
       LEFT JOIN meta_entities ce ON ce.account_id = e.account_id AND ce.level = 'campaign' AND ce.entity_id = e.campaign_id
       LEFT JOIN campaign_offer_overrides o ON o.account_id = e.account_id AND o.campaign_id = e.campaign_id
       LEFT JOIN marketer_campaign_client m ON m.account_id = e.account_id AND m.campaign_id = e.campaign_id AND m.is_primary
       WHERE c.account_id = ANY($1) AND e.effective_status = 'ACTIVE'`,
      [scope.accountIds]
    );
    for (const a of ads) {
      const text = [...(a.bodies || []), ...(a.titles || []), ...(a.descriptions || [])].map(v => v.text).join('\n');
      if (!text.trim()) continue;
      // The ad's own name may declare a different offer than its campaign
      // (e.g. a Free7DayPass ad inside a Join50%Off campaign) — judge
      // against the AD's offer when it declares one the rules know.
      const adOffer = parseOfferFromAdName(a.ad_name || '');
      const judgeOffer = OFFER_EXPECTATIONS[adOffer] ? adOffer : a.offer;
      if (wanted('copy_offer_mismatch')) {
        const j = judgeCopyAgainstOffer(text, judgeOffer);
        if (j.known && (j.conflicts.length > 0 || j.missing)) {
          const conflict = j.conflicts.length > 0;
          alerts.push({
            key: `copy_offer_mismatch:${a.account_id}:${a.ad_id}`, kind: 'copy_offer_mismatch', severity: conflict ? 'high' : 'low',
            title: conflict ? `Copy names a competing offer (${j.conflicts.join(', ')}) — ${a.ad_name}` : `Copy never mentions ${judgeOffer} — ${a.ad_name}`,
            detail: `${a.campaign_name ?? ''} · expected ${judgeOffer}; found signals: ${j.found.join(', ') || 'none'}. "${text.replace(/\s+/g, ' ').slice(0, 160)}…"`,
            clientId: a.client_id, clientName: clientName(a.client_id), accountId: a.account_id, level: 'ad', entityId: a.ad_id,
            metrics: { offer: judgeOffer, conflicts: j.conflicts.join(','), found: j.found.join(',') }, url: adsManagerAdUrl(a.account_id, a.ad_id), dismissed: false, snoozedUntil: null,
          });
        }
      }
      if (wanted('greeting_city_mismatch') && a.campaign_name) {
        const greet = (text.match(/Hey\s+([^!\n📢]+?)\s*!/i)?.[1] || '').trim().toLowerCase();
        const city = parseCityFromCampaignName(a.campaign_name).toLowerCase();
        if (greet && city) {
          const g0 = greet.split(' ')[0], c0 = city.split(' ')[0];
          const allowed = GREETING_ALLOW.some(([x, y]) => (greet.includes(x) && city.includes(y)) || (greet.includes(y) && city.includes(x)));
          if (!allowed && !greet.includes(c0) && !city.includes(g0)) {
            alerts.push({
              key: `greeting_city_mismatch:${a.account_id}:${a.ad_id}`, kind: 'greeting_city_mismatch', severity: 'high',
              title: `"Hey ${greet}!" in a ${city} campaign — ${a.ad_name}`,
              detail: `${a.campaign_name}: the greeting names a different place than the campaign's city. Could be dual branding (verify the club's own page) or a copy-paste error.`,
              clientId: a.client_id, clientName: clientName(a.client_id), accountId: a.account_id, level: 'ad', entityId: a.ad_id,
              metrics: { greeting: greet, city }, url: adsManagerAdUrl(a.account_id, a.ad_id), dismissed: false, snoozedUntil: null,
            });
          }
        }
      }
    }
  }

  // ── Creative fatigue ─────────────────────────────────────────────────
  if (wanted('creative_fatigue')) {
    try {
      const fat = await detectFatigue({ until: f.until });
      for (const r of fat.rows) {
        if (r.activeAds === 0) continue; // already retired — nothing to act on
        alerts.push({
          key: `creative_fatigue:${r.assetKey}`, kind: 'creative_fatigue', severity: r.spend >= 1000 ? 'medium' : 'low',
          title: `Creative fatigue — ${r.type} ${r.assetKey.slice(0, 22)}… still in ${r.activeAds} active ad${r.activeAds === 1 ? '' : 's'}`,
          detail: `${r.reasons.includes('ctr_decline') ? `CTR fell ${r.ctrDropPct?.toFixed(0)}% from its best week over 3 straight weeks` : ''}${r.reasons.length === 2 ? '; ' : ''}${r.reasons.includes('high_frequency') ? `frequency ${r.frequency?.toFixed(1)}` : ''}. $${r.spend.toFixed(0)} in 28 days${r.clients.length ? ` · ${r.clients.slice(0, 3).join(', ')}` : ''}.`,
          clientId: null, clientName: r.clients[0] ?? null, accountId: r.thumbAccountId, level: 'asset', entityId: r.assetKey,
          metrics: { spend28d: r.spend, frequency: r.frequency, ctrDropPct: r.ctrDropPct, activeAds: r.activeAds, thumbnailUrl: r.thumbnailUrl }, url: null, dismissed: false, snoozedUntil: null,
        });
      }
    } catch (err) {
      console.error('[MARKETER-ALERTS]', JSON.stringify({ step: 'fatigue', error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // ── Sync freshness ───────────────────────────────────────────────────
  if (wanted('stale_sync') && scope.accountIds.length) {
    const rows = await query<{ account_id: string; status: string; last_synced_at: string | null; last_success_until: string | null; last_error: string | null }>(
      `SELECT account_id, status, last_synced_at, last_success_until, last_error FROM agency_meta_sync_state WHERE account_id = ANY($1)`, [scope.accountIds]
    );
    const byAcct = new Map(rows.map(r => [r.account_id, r]));
    for (const id of scope.accountIds) {
      const s = byAcct.get(id);
      const ageH = s?.last_synced_at ? (Date.now() - new Date(s.last_synced_at).getTime()) / 3600_000 : Infinity;
      if (s?.status !== 'error' && ageH < STALE_SYNC_HOURS) continue;
      alerts.push({
        key: `stale_sync:${id}`, kind: 'stale_sync', severity: s?.status === 'error' ? 'medium' : 'low',
        title: `${s?.status === 'error' ? 'Sync error' : 'Stale data'} — ${scope.accountNameById.get(id) || id}`,
        detail: s ? `Last synced ${s.last_synced_at ? `${Math.round(ageH)} h ago` : 'never'}; data through ${s.last_success_until ?? '—'}${s.last_error ? `; ${s.last_error.slice(0, 120)}` : ''}.` : 'Never synced.',
        clientId: null, clientName: null, accountId: id, level: 'account', entityId: id, metrics: { ageHours: Number.isFinite(ageH) ? Math.round(ageH) : null }, url: null, dismissed: false, snoozedUntil: null,
      });
    }
  }

  // ── Dismissals + filters ─────────────────────────────────────────────
  const keys = alerts.map(a => a.key);
  if (keys.length) {
    const dism = await query<{ alert_key: string; snooze_until: string | null }>(
      `SELECT alert_key, snooze_until FROM marketer_alert_dismissals WHERE alert_key = ANY($1)`, [keys]
    );
    const byKey = new Map(dism.map(d => [d.alert_key, d]));
    for (const a of alerts) {
      const d = byKey.get(a.key);
      if (!d) continue;
      const active = !d.snooze_until || new Date(d.snooze_until).getTime() > Date.now();
      a.dismissed = active;
      a.snoozedUntil = d.snooze_until;
    }
  }
  let out = alerts;
  if (!f.includeDismissed) out = out.filter(a => !a.dismissed);
  if (f.clientIds?.length) out = out.filter(a => a.clientId && f.clientIds!.includes(a.clientId));
  if (f.brand) out = out.filter(a => a.clientId && scope.clientById.get(a.clientId)?.brand === f.brand);
  out.sort((a, b) => rank(b.severity) - rank(a.severity) || (Number(b.metrics.spend7d ?? b.metrics.combinedSpend ?? b.metrics.spend28d ?? 0) - Number(a.metrics.spend7d ?? a.metrics.combinedSpend ?? a.metrics.spend28d ?? 0)));

  const counts = {} as Record<AlertKind, number>;
  for (const a of out) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return { until: f.until, windows: { last7, prior28 }, alerts: out, counts, generatedAt: new Date().toISOString() };
}
