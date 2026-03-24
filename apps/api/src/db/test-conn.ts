import 'dotenv/config'; // Should load from root if run via npm from root
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../../../.env') });

const url = process.env.DATABASE_URL;
console.log('--- DB Diagnostic ---');
console.log('DATABASE_URL set:', !!url);
if (url) {
  const masked = url.replace(/:([^@]+)@/, ':****@');
  console.log('Masked URL:', masked);
  
  const host = url.split('@')[1]?.split(':')[0]?.split('/')[0];
  console.log('Host to connect:', host);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
});

async function test() {
  try {
    console.log('Connecting...');
    const res = await pool.query('SELECT NOW()');
    console.log('SUCCESS! Server time:', res.rows[0].now);
  } catch (err: any) {
    console.error('FAILED!', err.message);
    if (err.code === 'ENOTFOUND') {
      console.log('TIP: Host not found. If your network is IPv4-only, try the Supabase Pooler host instead of the direct DB host.');
    }
  } finally {
    await pool.end();
  }
}

test();
