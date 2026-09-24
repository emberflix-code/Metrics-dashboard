/**
 * Creates (or resets the password of) a marketer user — the agency
 * marketing-specialist role that sees every active client under /marketer.
 * No client_users row: marketers are not scoped to one client.
 *
 * Usage: node scripts/create-marketer.mjs marketer@agency.com yourpassword
 * Prod:  railway run --service Metrics-dashboard node scripts/create-marketer.mjs <email> <password>
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [,, email, password] = process.argv;

if (!email || !password) {
  console.error('Usage: node scripts/create-marketer.mjs <email> <password>');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Password must be at least 6 characters');
  process.exit(1);
}

// Railway Postgres (via `railway run`) needs SSL; a local DB does not.
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
  `INSERT INTO users (email, password_hash, role)
   VALUES ($1, $2, 'marketer')
   ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'marketer'
   RETURNING id, email, role`,
  [email.toLowerCase().trim(), hash]
);

console.log('Marketer user ready:', rows[0]);
await pool.end();
