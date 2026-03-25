
import db from './src/db/client.js';

async function fix() {
  try {
    console.log('🛠 Fixing llm_settings_provider_check constraint...');
    
    // Drop the naming constraint if it exists (it's often named after the table + column + 'check')
    await db.query(`ALTER TABLE llm_settings DROP CONSTRAINT IF EXISTS llm_settings_provider_check`);
    
    // Re-add with new allowed values
    await db.query(`
      ALTER TABLE llm_settings 
      ADD CONSTRAINT llm_settings_provider_check 
      CHECK (provider IN ('llama-local','ollama','groq','gemini','openai','anthropic','custom'))
    `);
    
    console.log('✅ Constraint updated successfully.');
  } catch (err) {
    console.error('❌ Fix failed:', err);
  } finally {
    process.exit(0);
  }
}

fix();
