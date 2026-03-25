
import db from './src/db/client.js';

async function check() {
  try {
    const r = await db.query('SELECT id, provider, model_name, is_default, base_url FROM llm_settings');
    console.log(JSON.stringify(r.rows, null, 2));
    
    const a = await db.query('SELECT name, llm_provider_id FROM agents');
    console.log(JSON.stringify(a.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

check();
