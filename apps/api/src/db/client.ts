import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from apps/api OR the monorepo root
dotenv.config();
dotenv.config({ path: join(__dirname, '../../../../.env') });
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

// Supabase Transaction Pooler — keep pool small to stay within connection limits
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: { rejectUnauthorized: false }, // Required for Supabase
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error', err);
});

export default pool;
