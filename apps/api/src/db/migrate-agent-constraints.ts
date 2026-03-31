import pool from './client.js';

async function migrateAgentConstraints() {
  console.log('▶  Adding agent execution constraint columns...');
  
  try {
    // Add execution constraint columns to agents table
    await pool.query(`
      ALTER TABLE agents 
      ADD COLUMN IF NOT EXISTS max_turns INTEGER,
      ADD COLUMN IF NOT EXISTS timeout_ms INTEGER,
      ADD COLUMN IF NOT EXISTS temperature REAL
    `);
    
    // Add constraint for temperature range (0-2)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'agents_temperature_check'
        ) THEN
          ALTER TABLE agents 
          ADD CONSTRAINT agents_temperature_check 
          CHECK (temperature IS NULL OR (temperature >= 0 AND temperature <= 2));
        END IF;
      END $$;
    `);
    
    // Add constraint for max_turns (must be positive)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'agents_max_turns_check'
        ) THEN
          ALTER TABLE agents 
          ADD CONSTRAINT agents_max_turns_check 
          CHECK (max_turns IS NULL OR max_turns > 0);
        END IF;
      END $$;
    `);
    
    // Add constraint for timeout_ms (must be non-negative)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'agents_timeout_ms_check'
        ) THEN
          ALTER TABLE agents 
          ADD CONSTRAINT agents_timeout_ms_check 
          CHECK (timeout_ms IS NULL OR timeout_ms >= 0);
        END IF;
      END $$;
    `);
    
    console.log('✅  Agent constraints migration complete');
  } catch (err) {
    console.error('❌  Migration failed:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

migrateAgentConstraints();
