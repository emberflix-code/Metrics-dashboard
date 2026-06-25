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

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}
