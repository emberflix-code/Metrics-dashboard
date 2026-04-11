/**
 * Creates the first admin user.
 * Usage: node scripts/create-admin.mjs admin@agency.com yourpassword
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [,, email, password] = process.argv;

if (!email || !password) {
  console.error('Usage: node scripts/create-admin.mjs <email> <password>');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
  `INSERT INTO users (email, password_hash, role)
   VALUES ($1, $2, 'admin')
   ON CONFLICT (email) DO UPDATE SET password_hash = $2
   RETURNING id, email, role`,
  [email.toLowerCase().trim(), hash]
);

console.log('Admin user ready:', rows[0]);
await pool.end();
