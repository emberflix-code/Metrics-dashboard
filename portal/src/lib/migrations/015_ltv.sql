-- LTV/CLV KPI card: won leads in the selected date range (from the same
-- acquisitions sheet the CPA card reads) x an admin-entered value per sale.
-- ltv_value stores that per-sale dollar amount, not a final total. Off by
-- default (show_ltv), matching the show_cpa pattern.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS ltv_value NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_ltv BOOLEAN NOT NULL DEFAULT false;
