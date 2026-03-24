import db from '../src/db/client.js';

async function alter() {
  try {
    await db.query(`ALTER TABLE agents ADD COLUMN agent_group TEXT NOT NULL DEFAULT ''`);
    await db.query(`ALTER TABLE agents DROP COLUMN IF EXISTS model_name`);
    console.log('Altered agents table smoothly.');
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
alter();
