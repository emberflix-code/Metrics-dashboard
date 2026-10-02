---
name: meta-leadgen-optimization
description: Diagnose and optimize Meta (Facebook/Instagram) lead-generation campaigns for this agency's gym/fitness clients (Anytime Fitness, Alloy Personal Training, etc.) using the dashboard's cached Meta DB plus an optional read-only live Meta lookup, then give prioritized, numbers-backed recommendations. Use this whenever the user asks how a client's or ad account's Meta ads are doing, why CPL/cost per lead went up, why leads dropped, what to pause/scale/fix, whether budget is being wasted, creative fatigue, learning limited, ad set consolidation, or asks for an optimization review/audit/health check of campaigns, even if they don't say "optimize" (e.g. "what's going on with Windermere's ads", "Omega CPL is terrible this week", "which Alloy locations need attention"). Read-only: never changes anything in Meta.
---

# Meta lead-gen optimization

Goal: turn a client's (or ad account's) recent Meta data into a short list of concrete, prioritized actions a media buyer can take in Ads Manager today, each backed by the numbers that justify it. This skill **analyzes and recommends only**. It never writes to Meta or to the DB. The user makes changes in Ads Manager themselves.

## Workflow

### 1. Pin down scope and period

- **Scope:** a client row (a location dashboard), a rollup client (e.g. "Alloy Ops"), or a whole ad account. Client names are long ("Alloy Personal Training Windermere, GA"). When unsure, run `--client "<substring>" --list` first, then pass the exact name or client UUID.
- **Period:** default is the last 14 complete days ending yesterday, compared with the prior 14 days. Use a different window if the user names one. Never include today: today is partial and makes every metric look worse.

### 2. Pull the snapshot

Run from `portal/` (so `pg` resolves), against prod:

```
railway run --service Metrics-dashboard npx --yes tsx ../.claude/skills/meta-leadgen-optimization/scripts/leadgen_snapshot.ts --client "<exact client name or uuid>" --live --out <scratchpad>/<slug>.json
```

Other forms: `--account <id>` for a whole account (no campaign filter), `--since/--until YYYY-MM-DD`, `--client "<substring>" --list`.

**Several locations at once** ("which Alloy locations need attention", "how are the Anytime Fitness clubs doing"): don't loop `--client`. Run `--triage "<name substring>" --out ...`. It returns one row per active, non-rollup client, worst first, in a single query:
- spend, results, CPL
- `target_cpl`: the benchmark for the offer carrying the most spend
- prior CPL, zero-lead days
- `flags`
- `flagged_campaigns`: each with `still_spending` and `last_spend_date`

Then drill into the top 3–6 with `--client "<client_id>" --live`. `flagged_live_spend` is the spend on flagged campaigns that are still running. It's a sorting signal, not a waste figure: a single campaign that's merely expensive, or a new one still learning, also counts. Apply the playbook before calling it waste. `no_spend_check_campaign_filter` means the client's filter matched no campaigns with spend. Usually the campaigns were renamed, and that's worth telling the user.

`--live` adds the fields the DB does not store, under `live` on each campaign and ad set:
- current status
- campaign budget (CBO), bid strategy, objective
- ad-set promoted event, created date, and **learning stage**

`learning_stage` is `LEARNING`, `SUCCESS` or `FAIL` (FAIL = "Learning Limited"). Null means Meta didn't report one, usually because the ad set is paused or not delivering. Don't read null as Limited. `live.errors` lists IDs Meta refused. The rest of the lookup still completes.

Every metrics block also carries `last_spend_date`. A campaign that spent early in the window but has a DB/live status of PAUSED has already been dealt with, so don't recommend pausing it again. It uses GET requests only and is batched with `?ids=` (50 per call) to avoid Meta's per-user rate limit. Use it for single clients. For a whole big account (Omega, Alloy Ops) skip `--live` or narrow the scope, because hundreds of ad sets mean many calls.

Write the JSON to the scratchpad and read it with the Read tool. Don't dump it to the terminal.

### 3. Check data health before judging anything

Most "the numbers look wrong" moments are sync lag, not performance. Before any diagnosis:

- Look at the `sync` rows. `last_success_until` (campaign level), `adset_insights_until` and `ad_insights_until` are tracked **separately**, and ad-level often lags. If a level ends before `period.until`, its figures are truncated. Say so, and don't compare that level against campaign totals.
- `coverage.warning` set means ad-set or ad totals cover less than 95% of campaign spend. Judge that level on ratios only (CPL, CTR, click-to-lead), not totals. If each ad set has one ad, use the ad-set level instead.
- `totals.prior_is_partial: true` means the prior period had spend on fewer than half its days (usually a new campaign). The period-over-period % change is then meaningless. Use `totals.current_halves` to see the real trend inside the current window.
- `status: error`, or `last_synced_at` older than ~36h, means the data is stale. Lead with that.
- Omega (4594093867301854) and five other AF accounts count `results` with an Ads Manager-matching rule (form-only for new LEAD_GENERATION campaigns). The stored `results` already has this applied, so don't recompute it.

### 3b. Use the lead count the client's dashboard uses

Meta `results` is only Meta's own claim. Each client's dashboard config says where its real lead count comes from, and the snapshot reads it under `client_leads`, reusing the dashboard's own sheet/GHL code:

- `client_leads.resolved` is the source the dashboard's Leads card actually uses: `sheet`, `ghl` or `meta`. It follows the same fallback as `dashboard/page.tsx`. `warnings` catches config traps. For example, `use_sheet_for_leads=false` means the card really shows Meta leads even though `leads_source` says sheet. Report that as a config issue.
- **Headline CPL = `client_leads.dashboard_cpl`**, i.e. Meta spend ÷ the client's leads. That's the number the client sees and is closest to real leads. Show Meta CPL beside it. Per campaign, use `client_leads` / `client_cpl` on each campaign.
- `meta_vs_client_leads.gap_pct`: a gap of ±20% or more is itself a finding:
  - **Meta well above the client's count:** Meta is counting leads that never reach the client, for example duplicate or junk form fills, or the pixel firing on the wrong page. Meta then optimizes toward the wrong thing. Recommend checking the form/pixel, and moving to higher-intent forms or conversion leads if it's instant forms.
  - **Client count well above Meta:** leads arrive that Meta can't see, because the pixel is missing, or leads are keyed by hand, or they come from other channels. Meta's optimization is then under-informed.
- **Sheet** (`client_leads.sheet`):
  - `by_campaign` maps each sheet "Campaign Name" to a Meta campaign by exact name, the same join the campaigns table uses.
  - `unmatched_leads` are sheet leads whose name matches no Meta campaign, usually a renamed or ended campaign. The dashboard's campaigns table under-counts them.
  - `outside_filter_leads` are rows the Leads card counts even though the campaign isn't this client's. The card doesn't apply `campaign_filter`.
- **GHL** (`client_leads.ghl`). Counted exactly like the Leads card: Leads Tag rule, dated in the ad account's timezone, plus form submissions.
  - `by_campaign` attributes each lead through `attributionSource.campaign`, which holds the Meta campaign ID. The dashboard itself doesn't do this, so this attribution is the skill's own.
  - `per_lead` lists every lead: day, contact id, attributed campaign, form `utm_campaign`, and whether it's booked. Use it to verify attribution yourself when numbers disagree.
  - `attributionSource` is **first touch**. A lead attributed to an old, paused campaign is usually a returning contact who first came in through it; it doesn't mean that campaign is still spending.
  - A value that's a name rather than an ID (e.g. `[GMM] … Presale`) comes from another agency's or an older setup's campaigns. `unattributed_leads` are organic, walk-in or unknown.
  - `booked` per campaign is a first quality signal: CPL on booked leads beats raw CPL.
- If a client has GHL configured as well as a sheet, both are computed. Use the second one as a cross-check (`ghl_cross_check_leads` in triage).
- Judge pause, scale and consolidate decisions on the client's leads when they're available. Structural or learning diagnoses (learning stage, fragmentation) still come from Meta results, because that's the event Meta optimizes on. `target_cpl` and the benchmark are Meta-results based, so client-CPL comparisons against them are approximate. Say so.
- Triage rows carry `lead_source`, `client_leads`, `client_cpl` and `meta_vs_client_gap_pct`, with flags `meta_vs_<source>_gap_<n>%` and `client_leads_worse_than_meta`. A location that looks fine on Meta but not on the client's leads needs attention too. Rank on client CPL when it's available.
- `--meta-only` skips the sheet/GHL fetch. Use it only when the user asks about Meta numbers specifically.

### 4. Diagnose

Work top-down. Stop drilling into a branch when the numbers are too small to support a conclusion. Read [references/playbook.md](references/playbook.md) for the thresholds, the diagnostic tree, and how each finding maps to an action.

1. **Account/client level:** CPL vs prior period and vs `benchmark` (agency median for the same offer, then overall). Separate the volume story (spend, CPM, CTR) from the conversion story (click-to-lead %). Look at `daily` for zero-lead days, spikes, and weekday patterns.
2. **Campaign level:** which campaigns carry spend, CPL outliers, and zero-lead spenders. Also flag overlapping campaigns for the same location and offer that compete with each other.
3. **Ad-set level:** learning stage, budget per ad set vs the ~50 results/week learning threshold, and fragmentation (many tiny ad sets under one CBO). Check that `optimization_goal`/`promoted_event` is actually a lead event.
4. **Ad and creative level:** zero-lead ads with meaningful spend, winners, and fatigue in `creatives_weekly` (CTR falling week over week, rising frequency). Tie back to theme/UGC tags when present.
5. **Downstream quality:** if bookings, CPA or LTV data exist for the client (GHL bookings, CPA sheet), a cheap CPL with poor booking rate is not a win. Say what you can and can't see.

Always judge against **statistical sufficiency**. With a $33 CPL, an ad set with $80 spend and 1 lead proves nothing. The playbook's "enough data" rule decides whether a finding becomes an action, a watch item, or nothing.

### 5. Recommend

Each recommendation must be something the user can do in Ads Manager. Each one names:

- **What:** pause, scale, consolidate, refresh creative, fix tracking/goal, change offer, or leave alone.
- **Where:** campaign/ad set/ad **name + ID**, and the ad account as name + ID.
- **Why:** the specific numbers (spend, results, CPL vs benchmark or vs siblings, days).
- **Expected effect and confidence:** high, medium or low, based on data volume.

Respect how Meta's learning works. Don't recommend several simultaneous edits to one ad set. Scale budgets in ~20–30% steps every few days. Prefer consolidation over adding more ad sets. "Do nothing for now, it's still learning" is a legitimate recommendation when true.

## Output (chat)

Keep it scannable. Use this shape:

```
**<Client name>** · <Account name> (<account id>) · <since>–<until> vs prior <n> days

**Data health:** <one line: synced through X at each level; any gaps/caveats, or "clean">

**Leads:** <source> N (dashboard CPL $A) vs Meta N (CPL $B); <gap and what it means, or "in line">

**Verdict:** <2–3 sentences: CPL $X on the client's leads (±Y% vs prior; vs $Z agency median for <offer>), the one main thing driving it>

**Do now**
| # | Action | Where | Why (numbers) | Confidence |
|---|--------|-------|---------------|------------|

**Watch (not enough data yet)**
- <item — what would trigger action, e.g. "if still 0 leads after $X more">

**Can't see from here:** <e.g. lead quality beyond bookings, landing page, lead form content>
```

Limit "Do now" to the few actions that matter (usually 2–5), ordered by expected dollar impact. For rollups or multi-location requests, start with a one-line-per-location triage table (lead source, client leads vs Meta, client CPL vs Meta CPL, vs benchmark, flag), then give details only for the locations that need attention.

## Guardrails

- Read-only. If the user asks you to make the change in Meta, say this skill doesn't, and describe the exact edit for them to make.
- Money is in the ad account's currency. Canadian accounts (e.g. Canada AF) are CAD. Don't mix currencies in one benchmark comparison without saying so.
- Dates: "yesterday" means yesterday in the account's timezone (US accounts), not local machine time. Manila time can be a day ahead.
- Don't split ad-level leads evenly across Dynamic Creative assets. Per-asset results come from `creatives_weekly` (the real breakdown).
