import pool from './client.js';

async function migrateDryRun() {
  console.log('▶  Adding dry run columns...');
  
  try {
    // Add is_dry_run column
    await pool.query(`
      ALTER TABLE execution_runs 
      ADD COLUMN IF NOT EXISTS is_dry_run BOOLEAN NOT NULL DEFAULT false
    `);
    
    // Add trigger_type column
    await pool.query(`
      ALTER TABLE execution_runs 
      ADD COLUMN IF NOT EXISTS trigger_type TEXT DEFAULT 'manual'
    `);
    
    // Add constraint if it doesn't exist
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'execution_runs_trigger_type_check'
        ) THEN
          ALTER TABLE execution_runs 
          ADD CONSTRAINT execution_runs_trigger_type_check 
          CHECK (trigger_type IN ('dry_run','manual','schedule'));
        END IF;
      END $$;
    `);
    
    // Create dry run index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_exec_runs_dry_agent
      ON execution_runs(node_id, started_at DESC)
      WHERE is_dry_run = true
    `);
    
    // Add risk_level to tools
    await pool.query(`
      ALTER TABLE tools 
      ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low'
    `);
    
    // Add constraint if it doesn't exist
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'tools_risk_level_check'
        ) THEN
          ALTER TABLE tools 
          ADD CONSTRAINT tools_risk_level_check 
          CHECK (risk_level IN ('low','medium','high'));
        END IF;
      END $$;
    `);
    
    console.log('✅  Dry run migration complete');
  } catch (err) {
    console.error('❌  Migration failed:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

migrateDryRun();
