# Lead-gen optimization playbook

Thresholds here match the dashboard's own rule engines (marketer `alerts.ts`/`fatigue.ts`/`scorecard.ts`, the Insights tab), so recommendations line up with what the user sees in the app. Where this file adds a threshold of its own, it says why.

## Contents
1. Enough data? (the sufficiency rule)
2. Diagnostic tree: CPL went up / leads went down
3. Structure: learning, budget, fragmentation
4. Creative: winners, losers, fatigue
5. Offer and benchmark reading
6. Finding → action map
7. Things that look like problems but aren't

---

## 1. Enough data?

Let `T` = the target CPL. Use the client's own prior-period CPL if it's stable, otherwise the `benchmark.by_offer` median for their offer, otherwise `benchmark.median_cpl`.

| Situation | Verdict |
|---|---|
| Spend ≥ 2×T and 0 results | Actionable: likely broken or bad. Pause, or check tracking. |
| Spend ≥ 3×T and CPL ≥ 2×T | Actionable: underperformer. |
| Spend < 1.5×T, or results < 3 | Not enough data. Watch list only. |
| Results ≥ 5 and CPL ≤ 0.8× sibling average | Winner candidate (Insights tab rule). |

Precedence: the two spend-based "actionable" rows win over "results < 3". Heavy spend with almost no leads is exactly the evidence the rule is looking for. "Results < 3" protects against acting on thin data when spend is also small. Confidence rises with spend: ≥ 3×T → medium, ≥ 5×T → high.

Why: lead counts are Poisson-like, so 1 vs 3 leads is noise. At a $30 CPL, a single $90 ad set can't be told apart from average. Say this explicitly when relevant, because it stops the user from over-editing.

Marketer alert parity: `zero_lead_spend` fires at ≥ $150 over 7 days with 0 results (high at ≥ $400). `cpl_spike` fires when CPL over the last 7 days is ≥ 1.6× the 28-day baseline, with the baseline ≥ 5 leads and ≥ 2 recent leads (high at ≥ 2.5×).

## 2. Diagnostic tree: CPL went up / leads went down

CPL = CPM ÷ (CTR × click-to-lead × 1000). So a CPL change always decomposes into three levers. Find which one moved (compare `current` vs `prior`):

- **CPM up, CTR and CVR flat → auction/audience cost.** Causes: seasonality (Q4, January is expensive), audience too narrow (small radius, tight age bands), audience saturation, or more competing campaigns from the same franchise in the same area. Actions: broaden (Advantage+ audience, wider age, larger radius within reason), consolidate overlapping campaigns, or accept it as seasonal.
- **CTR down → creative/message problem.** Check `creatives_weekly` for fatigue. Actions: refresh creative, test a new hook or theme, rotate UGC.
- **Click-to-lead down → post-click problem.** Causes: landing page or form broken or slow, offer changed, form got longer, pixel/lead event not firing (a sudden drop to ~0 is a tracking problem, not performance), or a promoted event that isn't the lead event. Actions: check the page and form, verify events. Always flag a sudden cliff as "check tracking first".
- **Spend down → delivery.** Causes: budget cut, ads paused or rejected, payment issue, or learning limited. Check statuses and `live.learning_stage`.

Also look at `daily`. Two or more zero-lead days with normal spend is worth flagging (Insights tab rule). A single spike day at ≥ 2× the average spend often explains a period-over-period swing on its own.

## 3. Structure: learning, budget, fragmentation

Meta needs ~50 optimization events per ad set per week to exit learning. Ad sets that can't get there report `learning_stage: FAIL` (Ads Manager: "Learning Limited") and deliver less efficiently.

- **Capacity check:** for each ad set, weekly budget share ÷ T ≈ expected weekly results. Under CBO, use the ad set's actual share of spend. If the whole campaign can only buy ~15 leads/week, no single ad set will exit learning, and splitting further makes it worse.
- **Fragmentation pattern (common here):** one CBO campaign split into 5–8 ad sets by age/gender bands, each spending $5–15/day. Recommendation: consolidate into 1–2 ad sets (a broad age range with Advantage+ audience, or one per gender only if CPLs clearly differ with enough data). Let CBO pick the audience. Expected effect: exits learning, lower CPL over 1–2 weeks. Medium confidence.
- **Pause vs consolidate under CBO:** when the budget sits at campaign level, pausing one bad ad set just hands its budget to its siblings. That's fine as a quick fix if 1–2 ad sets are clearly bad by the sufficiency rule and the rest are fine. When most ad sets are small and learning-limited, pausing doesn't fix anything; consolidate instead. Offer the pause as the "if you can't rebuild today" fallback.
- **Budget scaling:** raise the budget of a stable winner by 20–30% every 3–4 days. Big jumps (more than ~50%) re-trigger learning. To scale faster, duplicate into a new campaign rather than doubling.
- **Edits reset learning:** any significant edit resets the learning phase. That includes a large budget change, a targeting change, adding or removing creative, and changing the optimization event. Batch edits, and don't change one ad set more than about once a week.
- **Wrong goal:** a lead-gen ad set optimizing for LINK_CLICKS, LANDING_PAGE_VIEWS or REACH will buy cheap clicks and few leads. It should be OFFSITE_CONVERSIONS with the promoted event LEAD, or LEAD_GENERATION for instant forms.
- **Bid strategy:** LOWEST_COST_WITHOUT_CAP is the right default at these budgets. Cost caps and bid caps on small budgets usually throttle delivery.

## 4. Creative: winners, losers, fatigue

From `ads` and `creatives_weekly`:

- **Fatigue (marketer `fatigue.ts` rule):** the asset has ≥ $300 over 28 days and either (a) CTR fell three weeks in a row with the latest week ≥ 30% below its best week, or (b) weekly frequency > 3.5. The snapshot's `avg_daily_freq` averages daily frequency, so it runs lower than weekly frequency. Treat > ~1.8 average daily as a sign of high repetition in small local audiences.
- **Losers:** apply the sufficiency rule above at ad level. With Dynamic Creative, judge assets from `creatives_weekly`, not by splitting ad results.
- **Winners:** keep them running and don't edit them. The best next test is a new variant of the winning theme/hook, not a random new concept.
- **Themes/UGC:** when `theme`/`ugc` tags exist, compare CPL by tag only with ≥ 10 leads per group (Insights tab rule). A gap ≥ 25% between themes, or ±20% UGC vs non-UGC, is worth reporting.
- **Local gym context:** audiences are small (a few-mile radius), so creative wears out faster than in national accounts. A 3–4 week refresh cadence is normal.

## 5. Offer and benchmark reading

- `benchmark.by_offer` is the agency-wide median campaign CPL for the same period, by offer (e.g. `Join50%Off`, `30-Day Transformation`, `JoinFor$1`). Compare against the matching offer first. Offers have very different natural CPLs.
- Only campaigns with ≥ $100 and ≥ 3 results are in the benchmark. A client at 1.3× the median is fine, and one at 2× deserves a look.
- Price-point offers (Alloy's paid 30-Day Transformation) naturally have higher CPL but better lead quality than free/$1 offers. Don't recommend switching offers purely on CPL without bookings or CPA evidence.
- Matching the offer: use the campaign's `offer` (parsed from the campaign name, e.g. `30-Day Transformation`), not `clients.offer`. The client's free-text offer ("Non Free 30 Day Challenge") won't match the benchmark keys.
- Circularity: for a big brand, the offer benchmark is mostly that brand's own campaigns (Alloy dominates `30-Day Transformation`). Comparing a location to it answers "is this location worse than its siblings?", not "is the brand's CPL good?". For a brand-level question, compare against the other offers and the overall median, and say which comparison you're making.
- Currency: the benchmark mixes accounts. For CAD accounts, say the comparison is approximate.

## 6. Finding → action map

| Finding | Action | Confidence cue |
|---|---|---|
| Ad set/ad passes the 0-results rule (§1) | Pause it | High if spend ≥ 3×T |
| Ad set CPL ≥ 2×T with enough data, siblings fine | Pause it, or let CBO shift budget if under CBO | Medium |
| Many small ad sets, learning FAIL | Consolidate | Medium |
| Stable winner, CPL ≤ 0.8×T, learning SUCCESS | Scale +20–30% | Medium–high |
| CTR decay / frequency high on top creative | Refresh: new variant of the same theme | Medium |
| Click-to-lead cliff (sudden) | Check tracking, landing page and form before anything else | High urgency |
| Optimization goal not a lead event | Rebuild with lead optimization | High |
| Two campaigns same location + offer | Merge, or give them separate geos/audiences | Medium |
| CPM spike across all accounts at once | Seasonal/auction. Explain it, no structural action | — |
| Everything within noise | Leave it alone. Say so explicitly | — |

## 7. Things that look like problems but aren't

- **Sync lag.** A level synced only partway into the period makes CPL look terrible. Check `sync` first.
- **New campaign.** The first 3–7 days have a volatile CPL during learning, and the prior period has little data (`active_days` small). Don't call a trend.
- **Prior period partial.** A campaign that launched mid-prior-period shows a misleading % change. Look at `prior.active_days`.
- **Sheet/GHL leads ≠ Meta results.** A small gap (under ±20%) is normal: attribution windows differ, and the sheet is updated by hand. See SKILL.md step 3b for what a big gap means.
- **GHL leads on paused campaigns.** GHL attribution is first touch. A returning contact keeps the campaign they first came from.
- **Attribution delay.** The last 1–2 days can gain leads for a few days (7-day click window). Treat a "yesterday was bad" reading cautiously.
