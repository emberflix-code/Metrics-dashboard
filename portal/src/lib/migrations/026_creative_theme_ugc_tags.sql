-- Admin-only manual creative tagging (while impersonating a client — see
-- _isAdminView in DashboardClient.tsx): Theme and UGC status, neither of
-- which Meta's API has any concept of.
--
-- theme is one of: 'non-active' | 'strength' | 'tread' | 'strength+tread'
-- ugc_status is one of: 'ugc' | 'non-ugc'
--
-- Nullable — untagged is a real state, not an implicit extra value. Both
-- constrained at the application layer (POST /api/admin/creative-tags),
-- not a DB CHECK constraint, matching this codebase's existing style for
-- admin-form-driven fixed option lists.

ALTER TABLE meta_creative_assets ADD COLUMN IF NOT EXISTS theme TEXT;
ALTER TABLE meta_creative_assets ADD COLUMN IF NOT EXISTS ugc_status TEXT;
