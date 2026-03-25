import db from './client.js';
import { v4 as uuidv4 } from 'uuid';

async function seed() {
  console.log('🌱 Seeding database...');
  
  try {
    // 1. System-provided Llama Local
    await db.query(`DELETE FROM llm_settings WHERE provider = $1`, ['llama-local']);
    const llamaLocalId = uuidv4();
    await db.query(`
      INSERT INTO llm_settings (id, provider, api_key, model_name, is_default, base_url)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [llamaLocalId, 'llama-local', 'not-required', 'llama3.2', false, 'http://localhost:11434/v1']);

    // GLM-5 Cloud via Anthropic Wrapper (System Default)
    // Clear existing defaults and delete old rows for GLM-5
    await db.query(`UPDATE llm_settings SET is_default = false`);
    await db.query(`DELETE FROM llm_settings WHERE (provider = 'ollama' OR provider = 'anthropic') AND model_name = 'glm-5:cloud'`);
    const glmId = uuidv4();
    await db.query(`
      INSERT INTO llm_settings (id, provider, api_key, model_name, is_default, base_url)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [glmId, 'anthropic', '', 'glm-5:cloud', true, 'http://localhost:11434']);
    
    console.log('✅ LLM settings seeded (Anthropic-Ollama Bridge for GLM-5)');

    // 3. Test Agent (using the new default)
    await db.query(`DELETE FROM agents WHERE name = $1`, ['Test Agent']);
    const agentId = uuidv4();
    await db.query(`
      INSERT INTO agents (id, name, skill, llm_provider_id)
      VALUES ($1, $2, $3, $4)
    `, [agentId, 'Test Agent', 'You are a helpful assistant.', glmId]);
    
    console.log('✅ Test agent seeded:', agentId);

  } catch (err) {
    console.error('❌ Seeding failed:', err);
  } finally {
    process.exit(0);
  }
}

seed();
