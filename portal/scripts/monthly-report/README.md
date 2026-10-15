# Monthly Alloy report + GMN Marketing Report scripts

Offline scripts that build the monthly Alloy report (the xlsx behind the client slide deck) and the snapshot shown on the
in-app **GMN Marketing Report** page (`/dashboard/gmn-report`). All read-only against prod except `_publish_monthly_report.ts`,
which writes one `client_monthly_reports` row. Run from `portal/`; prefix `railway run --service Metrics-dashboard` for prod.
Excluded from the Next.js type-check (`tsconfig.json`), so they can never break a deploy.

Order for a month (`<M>` = `YYYY-MM`, `<S>` = a scratch folder):

1. `npx --yes tsx scripts/monthly-report/_live_vs_cached.ts <since> <until> <S> alloy` — Meta live vs cached + sheet leads per location (~25 min).
2. `npx --yes tsx scripts/monthly-report/_alloy_month_bookings.ts <M> <S>/alloy_bookings_<M>.json` — GHL booking-calendar audit (~25 min).
3. `npx --yes tsx scripts/monthly-report/_alloy_month_ghl_leads.ts <M> <S>/alloy_ghl_leads_<M>.json` — GHL leads + Meta active status.
4. `npx --yes tsx scripts/monthly-report/_alloy_month_offers.ts <M> <S>/alloy_offers_<M>.json` — per location × offer.
5. `npx --yes tsx scripts/monthly-report/_alloy_month_top_creatives.ts <M> <S>/alloy_top_creatives_<M>.json` — top 10 creatives (env `QA_DIR` writes contact sheets to check the grouping).
6. `python scripts/monthly-report/_build_alloy_month_xlsx.py <S>/live_vs_cached_<since>_<until>.json "Sep 2026" "September 1-30, 2026" ../reports/alloy_live_vs_cached_<M> <pulled date> <bookings> <ghl_leads> <offers> <top_creatives>`
   → xlsx + csv + tsv + `.payload.json`; then recalculate the xlsx in Excel.
7. `npx --yes tsx scripts/monthly-report/_publish_monthly_report.ts --client <uuid> --month <M> --file ../reports/alloy_live_vs_cached_<M>.payload.json` (`--draft`, `--unpublish`, `--show`).

Helpers: `_alloy_unmatched_campaigns.ts <since> <until>` (spending Alloy campaigns no location filter matches),
`_ghl_token_audit.ts <out>` (every client's GHL token: location, name, contacts/calendars/forms access).

Rules (bookings definition, calendar-count exclusions, duplicates, offers, creative grouping) are documented at the top of each script.
