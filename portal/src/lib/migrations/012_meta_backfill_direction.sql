-- Recent-first, month-chunked backfill (see metaSync.ts buildSyncRanges).
--
-- Backfill previously walked floorDate -> yesterday (oldest-first, in 3-day
-- chunks with no coarser checkpoint). A large account (~58k campaigns/
-- adsets/ads) interrupted repeatedly by rate limits and request timeouts
-- sat for hours with only ~9 months of ancient (2023-2024) history synced
-- and nothing from the last two years — the dashboard showed stale data
-- while the backfill kept crawling forward from the 37-month floor.
--
-- newest_synced / creatives_newest_synced track the frontier of the NEW
-- backward-from-yesterday walk, checkpointed at calendar-month boundaries
-- so admin-panel progress reads as "N of M months backfilled" instead of a
-- single a stuck-looking date. earliest_synced / creatives_earliest_synced
-- and backfill_complete / creatives_backfill_complete keep their existing
-- meaning (oldest point reached; whether floorDate was reached) — only the
-- ORDER of arrival changes.
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS newest_synced TEXT;
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS creatives_newest_synced TEXT;
