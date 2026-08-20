-- Independent per-client toggle to hide the "Adset Sets" and "Ads" level
-- tabs from the Meta dashboard, leaving only "Campaigns" (plus Creatives /
-- Creatives v2, which are unaffected). Not tied to show_creative_campaign_
-- breakdown — a client can have either toggle, both, or neither.
--
-- Shipped defaulting to false (visible), then flipped to hidden for every
-- client per product decision. The _defaulted guard column ensures the
-- one-shot flip only applies once, so an admin who explicitly re-enables
-- the tabs for a specific client afterward doesn't get reverted.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS hide_adset_ad_tabs BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS hide_adset_ad_tabs_defaulted BOOLEAN NOT NULL DEFAULT false;
UPDATE clients SET hide_adset_ad_tabs = true, hide_adset_ad_tabs_defaulted = true WHERE hide_adset_ad_tabs_defaulted = false;
