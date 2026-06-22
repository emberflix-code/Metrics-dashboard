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

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}
