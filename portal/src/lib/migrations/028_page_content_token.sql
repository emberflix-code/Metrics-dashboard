-- Single agency-wide System User token with Page-level "Partial access"
-- (Ads + Insights + pages_read_engagement) — used only as a fallback to
-- recover a full-resolution creative image via an ad's
-- effective_object_story_id -> Page post -> full_picture, for assets whose
-- ad creative object exposes nothing but a tiny thumbnail_url. Distinct
-- from agency_bm_connections' per-ad-account tokens (those are ads_read
-- scoped and can't read Page post content at all).
CREATE TABLE IF NOT EXISTS agency_page_token (
  id                SERIAL PRIMARY KEY,
  token_enc         TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agency_page_token (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Per-client opt-in — same idiom as show_creative_campaign_breakdown /
-- show_creatives_v3. Off by default: the fallback makes one extra Graph API
-- call per low-res asset per sync, only worth paying for on accounts the
-- admin has actually checked have real (non-catalog) low-res creatives.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS enable_page_image_fallback BOOLEAN NOT NULL DEFAULT false;