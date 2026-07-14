import { Pool } from 'pg';

// Single connection pool reused across requests (Next.js hot-reload safe)
declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

function createPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

export const pool = globalThis._pgPool ?? createPool();
if (process.env.NODE_ENV !== 'production') globalThis._pgPool = pool;

// Add auto_login_token column if it doesn't exist yet
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_login_token TEXT UNIQUE`).catch(() => {});
// Per-client gate: when true, the Meta dashboard reads the lead KPI from
// the configured sheet_tab instead of Meta's pixel events. Defaults off so
// the rollout is opt-in per client.
pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS use_sheet_for_leads BOOLEAN NOT NULL DEFAULT false`).catch(() => {});

// GHL bookings integration + leads-source picker (see migration 010).
// Defaults are safe-no-op so existing clients are unaffected on first deploy:
// leads_source defaults to 'meta', show_bookings defaults to false.
pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_token_enc TEXT NOT NULL DEFAULT ''`).catch(() => {});
pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_location_id TEXT NOT NULL DEFAULT ''`).catch(() => {});
pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS leads_source TEXT NOT NULL DEFAULT 'meta'`).catch(() => {});
pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_bookings BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_book_rate BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
// One-shot backfill: any client that had `use_sheet_for_leads = true` now has
// `leads_source = 'sheet'`. Idempotent — the guard `leads_source = 'meta'`
// makes this no-op on re-run (admin may have manually switched to 'ghl' since).
pool.query(`UPDATE clients SET leads_source = 'sheet' WHERE use_sheet_for_leads = true AND leads_source = 'meta'`).catch(() => {});

// Multi-BM support: agency_bm_connections holds one row per Business Manager
// the agency has access to. Each row has its own token + ad accounts. The
// legacy agency_settings.meta_token_enc / meta_account_ids columns are still
// readable as a fallback, but new BMs should only be added to this table.
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agency_bm_connections (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label             TEXT NOT NULL,
        token_enc         TEXT NOT NULL,
        account_ids       TEXT[] NOT NULL DEFAULT '{}',
        accounts_json     JSONB NOT NULL DEFAULT '[]',
        sort_order        INT NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agency_bm_connections_account_ids ON agency_bm_connections USING GIN (account_ids)`);
    // Guard against multi-worker race on cold start: enforce label uniqueness
    // so the seed below cannot accidentally insert "BM 1" twice if two
    // workers both observe an empty table simultaneously.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_bm_connections_label ON agency_bm_connections (label)`);
    // One-shot seed: if the new table is empty AND the legacy single-token
    // row in agency_settings is populated, migrate that single token in as
    // "BM 1". The unique label index above makes a duplicate insert error
    // out, which we swallow harmlessly.
    const seeded = await pool.query(`SELECT 1 FROM agency_bm_connections LIMIT 1`);
    if (seeded.rowCount === 0) {
      const legacy = await pool.query<{ meta_token_enc: string | null; meta_account_ids: string[]; meta_accounts: unknown }>(
        `SELECT meta_token_enc, meta_account_ids, meta_accounts FROM agency_settings WHERE id = 1`
      );
      const row = legacy.rows[0];
      if (row?.meta_token_enc) {
        await pool.query(
          `INSERT INTO agency_bm_connections (label, token_enc, account_ids, accounts_json, sort_order)
           VALUES ($1, $2, $3, $4, 0)
           ON CONFLICT (label) DO NOTHING`,
          ['BM 1', row.meta_token_enc, row.meta_account_ids || [], JSON.stringify(row.meta_accounts || [])]
        );
      }
    }
  } catch { /* surface via routes if it fails */ }
})();

// DB-backed Meta cache (see migration 011_meta_cache.sql for full context).
// Per-client toggle: 'live' (default, unchanged) reads Meta live same as
// today; 'cached' reads these tables instead, populated by an admin-
// triggered sync (src/lib/metaSync.ts). Storage is per ad-account, not
// per-client — campaign_filter is applied at read time.
pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'live'`).catch(() => {});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agency_meta_sync_state (
        account_id           TEXT PRIMARY KEY,
        status               TEXT NOT NULL DEFAULT 'idle',
        last_synced_at       TIMESTAMPTZ,
        last_success_until   TEXT,
        earliest_synced      TEXT,
        backfill_complete    BOOLEAN NOT NULL DEFAULT false,
        last_error           TEXT,
        last_run_started_at  TIMESTAMPTZ,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Separate watermark for the creatives/DCO-breakdown backfill — distinct
    // from the insights watermark above (earliest_synced/backfill_complete)
    // because creatives used to always re-walk the full 37-month range on
    // every sync (expensive, and needlessly overwrites already-final data).
    await pool.query(`ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS creatives_earliest_synced TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS creatives_backfill_complete BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
    // Recent-first, month-chunked backfill watermark. Backfill used to walk
    // floorDate -> yesterday (oldest-first), so a large account interrupted
    // partway through could sit for hours with only ancient history synced
    // and nothing recent — exactly what happened to a 58k-entity account.
    // newest_synced tracks the frontier of the new backward-from-yesterday
    // walk; earliest_synced/backfill_complete keep their existing meaning
    // (oldest point reached; whether floorDate was reached) unchanged.
    await pool.query(`ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS newest_synced TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS creatives_newest_synced TEXT`).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_entities (
        account_id       TEXT NOT NULL,
        level            TEXT NOT NULL,
        entity_id        TEXT NOT NULL,
        name             TEXT NOT NULL DEFAULT '',
        campaign_id      TEXT,
        campaign_name    TEXT,
        adset_id         TEXT,
        adset_name       TEXT,
        effective_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, level, entity_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_entities_campaign ON meta_entities (account_id, campaign_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_daily_insights (
        account_id     TEXT NOT NULL,
        level          TEXT NOT NULL,
        entity_id      TEXT NOT NULL,
        date           DATE NOT NULL,
        campaign_id    TEXT NOT NULL DEFAULT '',
        campaign_name  TEXT NOT NULL DEFAULT '',
        adset_id       TEXT NOT NULL DEFAULT '',
        adset_name     TEXT NOT NULL DEFAULT '',
        ad_name        TEXT NOT NULL DEFAULT '',
        reach          BIGINT NOT NULL DEFAULT 0,
        impressions    BIGINT NOT NULL DEFAULT 0,
        spend          NUMERIC(12,2) NOT NULL DEFAULT 0,
        link_clicks    BIGINT NOT NULL DEFAULT 0,
        results        BIGINT NOT NULL DEFAULT 0,
        synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, level, entity_id, date)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_daily_insights_range ON meta_daily_insights (account_id, level, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_daily_insights_campaign ON meta_daily_insights (account_id, campaign_id, date)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_creative_assets (
        account_id               TEXT NOT NULL,
        asset_key                TEXT NOT NULL,
        type                     TEXT NOT NULL,
        thumbnail                TEXT,
        thumbnail_fetched_at     TIMESTAMPTZ,
        video_source             TEXT,
        video_source_fetched_at  TIMESTAMPTZ,
        video_id                 TEXT,
        body                     TEXT,
        title                    TEXT,
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, asset_key)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_creative_asset_ad_map (
        account_id    TEXT NOT NULL,
        asset_key     TEXT NOT NULL,
        ad_id         TEXT NOT NULL,
        weight        NUMERIC(6,4) NOT NULL DEFAULT 1,
        PRIMARY KEY (account_id, asset_key, ad_id),
        FOREIGN KEY (account_id, asset_key) REFERENCES meta_creative_assets(account_id, asset_key) ON DELETE CASCADE
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_creative_asset_ad_map_ad ON meta_creative_asset_ad_map (account_id, ad_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS meta_asset_breakdown_daily (
        account_id   TEXT NOT NULL,
        asset_key    TEXT NOT NULL,
        ad_id        TEXT NOT NULL,
        date         DATE NOT NULL,
        spend        NUMERIC(12,2) NOT NULL DEFAULT 0,
        impressions  BIGINT NOT NULL DEFAULT 0,
        link_clicks  BIGINT NOT NULL DEFAULT 0,
        results      BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, asset_key, ad_id, date)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_asset_breakdown_daily_range ON meta_asset_breakdown_daily (account_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meta_asset_breakdown_daily_ad ON meta_asset_breakdown_daily (account_id, ad_id)`);
  } catch { /* surface via routes if it fails */ }
})();

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}
