// ── Ads Manager reporting basis ─────────────────────────────────────────
// Accounts whose cached figures are expected to reproduce what the user sees
// in Ads Manager, column for column. Two separate things follow from being in
// this set, and both exist because these clients reconcile the dashboard
// against their own Ads Manager exports:
//
//   1. `results` = Meta's combined `lead` action (pixel + form). See the long
//      comment on getResultsRules in metaSync.ts, including the form-only
//      branch that was withdrawn 2026-10-19 and why no campaign attribute can
//      bring it back.
//   2. Rows for campaigns with <= MIN_IMPRESSIONS impressions over the
//      reporting range are left out of dashboard figures, because Ads Manager
//      exports carry an `Impressions > 1` filter and therefore never show
//      them. See excludeBelowImpressionFloor below.
//
// It lives in its own module so both the sync and the read path can share one
// list without the API routes importing all of metaSync.
export const ADS_MANAGER_RESULTS_ACCOUNTS = new Set([
  '4594093867301854', // GymMembersNow AF Regional Omega
  '216024513873696',  // GymMembersNow AF #4299 - Grand Parkway, TX (Matthew McCool)
  '156873523271047',  // GymMembersNow - AF Multiple FZ's (Legacy) #1
  '886442192224283',  // GymMembersNow - AF Multiple FZ's (Legacy) #2
  '9135921576479804', // GymMembersNow AF Regional Aaron Meier
  '794347999225743',  // GymMembersNow AF Regional Rob Jent
]);

export function usesAdsManagerBasis(accountId: string): boolean {
  return ADS_MANAGER_RESULTS_ACCOUNTS.has(accountId);
}

// Ads Manager's own export filter is literally "Impressions > 1", so a
// campaign sitting at 0 or 1 impressions for the range is absent from the
// export entirely. Measured on the five Anytime Fitness accounts for
// Sep 2026: 12 Omega campaigns had 16 leads between them on $0 spend and
// exactly 0 impressions — late-attributed leads on campaigns that had stopped
// delivering. Keeping them made the dashboard read 6,221 against the user's
// 6,195. These ARE real leads, so this is a reporting-parity choice the user
// made deliberately (2026-10-19), not a correctness fix: a club with a
// late-attributed lead and no delivery in the period will not see it.
export const MIN_IMPRESSIONS = 1;

// The decision is per campaign over the WHOLE range, never per day — a
// campaign that delivered on one day and not another must keep all of its
// days. Callers build the qualifying set once per range and then filter every
// row (account totals, daily chart points, per-entity tables) through it, so
// the KPI card and everything under it agree.
export function qualifyingCampaignIds(
  campaignRows: { campaign_id: string; impressions: string | number }[]
): Set<string> {
  const byCampaign = new Map<string, number>();
  for (const r of campaignRows) {
    if (!r.campaign_id) continue;
    const n = typeof r.impressions === 'number' ? r.impressions : parseInt(r.impressions || '0', 10) || 0;
    byCampaign.set(r.campaign_id, (byCampaign.get(r.campaign_id) || 0) + n);
  }
  const out = new Set<string>();
  byCampaign.forEach((impressions, cid) => { if (impressions > MIN_IMPRESSIONS) out.add(cid); });
  return out;
}
