-- CPA KPI card: per-client "won leads" Google Sheet + retainer config.
--
-- cpa_sheet_id / cpa_sheet_tab: same public-CSV pattern as sheet_id/sheet_tab,
-- but pointed at a per-lead sheet (First Name, Last Name, Phone, Email,
-- Date Enrolled, Notes) instead of a per-campaign/day rollup. A lead counts
-- as an acquisition when its Notes cell starts with "Won".
--
-- retainer_mode: 'flat' (default) uses retainer_flat_amount for every month.
-- 'monthly' looks up client_retainers per calendar month; a month with no
-- row contributes 0 rather than falling back to the flat amount.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS cpa_sheet_id TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS cpa_sheet_tab TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_cpa BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS retainer_mode TEXT NOT NULL DEFAULT 'flat';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS retainer_flat_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS client_retainers (
  client_id  UUID NOT NULL,
  month      DATE NOT NULL,
  amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, month)
);
