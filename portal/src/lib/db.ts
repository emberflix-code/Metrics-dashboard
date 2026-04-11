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

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}
