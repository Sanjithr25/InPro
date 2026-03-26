import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function run() {
  const result = await pool.query(`
    SELECT id, node_type, node_id, parent_run_id, status, error_message,
           started_at, ended_at, created_at,
           output_data->>'output' as output_text
    FROM execution_runs WHERE id = $1 OR parent_run_id = $1
    ORDER BY created_at ASC
  `, ['f24a3f71-49a8-4489-af83-41f169184019']);
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit(0);
}

run();
