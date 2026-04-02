/**
 * Migration: Link tools → global_settings
 *
 * Adds a nullable `setting_key` FK column to the `tools` table that references
 * `global_settings(setting_key)`. Tools that depend on a global setting (e.g.
 * root_directory for file/system ops) are updated to reference it.
 *
 * Run via: npx tsx src/db/migrate-tools-settings.ts
 */
import 'dotenv/config';
import pool from './client.js';

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('▶  Linking tools → global_settings...');

    // 1. Add setting_key column with FK to global_settings
    await client.query(`
      ALTER TABLE tools
      ADD COLUMN IF NOT EXISTS setting_key TEXT REFERENCES global_settings(setting_key) ON DELETE SET NULL
    `);
    console.log('   ✓ Added setting_key FK column to tools');

    // 2. Index for efficient lookups by setting_key
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tools_setting_key ON tools(setting_key)
    `);
    console.log('   ✓ Created index on tools.setting_key');

    // 3. Link file & system operation tools to root_directory setting
    //    These tools use the sandbox root directory from global_settings
    const fileAndSystemTools = [
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
    ];

    const { rowCount } = await client.query(`
      UPDATE tools
      SET setting_key = 'root_directory'
      WHERE name = ANY($1)
        AND setting_key IS NULL
    `, [fileAndSystemTools]);

    console.log(`   ✓ Linked ${rowCount} tool(s) to 'root_directory' global setting`);

    console.log('✅  Migration complete: tools.setting_key → global_settings(setting_key)');
  } catch (err) {
    console.error('❌  Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
