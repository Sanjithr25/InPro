/**
 * Migration runner — reads schema.sql and executes it against Supabase.
 * Run via: npm run db:migrate (from apps/api)
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('▶  Running migrations…');
    await client.query(sql);
    console.log('✅  Migration complete');
  } catch (err) {
    console.error('❌  Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
