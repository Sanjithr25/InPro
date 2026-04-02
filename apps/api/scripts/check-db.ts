import 'dotenv/config';
import pool from '../src/db/client.js';

async function check() {
  const client = await pool.connect();
  try {
    const agents = await client.query('SELECT * FROM agents LIMIT 1');
    console.log('agents cols:', agents.fields.map(f => f.name));
    
    const llm = await client.query('SELECT * FROM llm_settings LIMIT 1');
    console.log('llm_settings cols:', llm.fields.map(f => f.name));
  } catch (err) {
    console.error(err);
  } finally {
    client.release();
    await pool.end();
  }
}
check();
