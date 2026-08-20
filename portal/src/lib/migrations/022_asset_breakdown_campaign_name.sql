-- Supports the "By Campaign" creative breakdown (see migration 021). The
-- cached-mode mirror of the Creatives tab reads from this table instead of
-- calling Meta live, so it needs campaign identity persisted per row too.
--
-- Not part of the primary key — an ad belongs to one campaign at a time in
-- practice, so this is a plain last-write-wins descriptive column, not a new
-- grouping dimension on the row itself.
--
-- Existing rows read '' (empty string) until the sync job's normal backfill
-- walk re-visits their date range and starts populating this column (see
-- metaSync.ts). A one-time targeted re-sync was run per already-cached
-- client after this shipped so historical data didn't have to wait on the
-- natural backfill schedule.

ALTER TABLE meta_asset_breakdown_daily ADD COLUMN IF NOT EXISTS campaign_name TEXT NOT NULL DEFAULT '';
