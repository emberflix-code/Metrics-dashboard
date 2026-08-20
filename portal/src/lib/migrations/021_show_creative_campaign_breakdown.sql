-- Creatives tab: per-client toggle for the "By Campaign" drill-down inside
-- the creative-asset modal. When a client clicks an image/video asset card,
-- the modal already shows a per-ad breakdown table ("N ads using this
-- creative"); this flag adds a sibling "By Campaign" view of the same asset's
-- spend/impressions/leads, grouped by campaign instead of by ad.
--
-- Off by default so existing clients see zero change in the Creatives tab
-- until an admin explicitly opts them in from the client detail page.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_creative_campaign_breakdown BOOLEAN NOT NULL DEFAULT false;
