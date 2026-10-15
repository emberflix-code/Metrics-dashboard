-- GMN Marketing Report: per-client toggle + monthly published snapshots.
-- The toggle shows a "GMN Marketing Report" button on the client dashboard that
-- opens /dashboard/gmn-report; the page reads the client's published months.
-- payload is built offline by the monthly report scripts (portal/_build_alloy_month_xlsx.py,
-- portal/_alloy_month_top_creatives.ts) and published with portal/_publish_monthly_report.ts.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_gmn_report BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS client_monthly_reports (
  id            SERIAL PRIMARY KEY,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month         DATE NOT NULL,
  payload       JSONB NOT NULL,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, month)
);
