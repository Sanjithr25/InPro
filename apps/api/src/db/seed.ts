import db from './client.js';
import { v4 as uuidv4 } from 'uuid';

async function seed() {
  console.log('🌱 Seeding database...');
  
  try {
    // 1. Secret/LLM Settings for Ollama (Llama 3.2)
    await db.query(`DELETE FROM llm_settings WHERE provider = $1`, ['ollama']);
    const llamaId = uuidv4();
    await db.query(`
      INSERT INTO llm_settings (id, provider, api_key, model_name, is_default, base_url)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [llamaId, 'ollama', '44938d319de9430b8ae8e0cbd0d2be1d.P4bVOKrakXH2Ep8-yzrF9pIH', 'llama3.2', true, 'http://localhost:11434/v1']);

    // 2. Secret/LLM Settings for GLM-5
    const glmId = uuidv4();
    await db.query(`
      INSERT INTO llm_settings (id, provider, api_key, model_name, is_default, base_url)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [glmId, 'ollama', '44938d319de9430b8ae8e0cbd0d2be1d.P4bVOKrakXH2Ep8-yzrF9pIH', 'glm-5:cloud', false, 'http://localhost:11434/v1']);
    
    console.log('✅ LLM settings seeded (Llama 3.2 + GLM-5)');

    // 3. Test Agent
    const agentId = uuidv4();
    await db.query(`
      INSERT INTO agents (id, name, skill, llm_provider_id)
      VALUES ($1, $2, $3, $4)
    `, [agentId, 'Test Agent', 'You are a helpful assistant.', llamaId]);
    
    console.log('✅ Test agent seeded:', agentId);

  } catch (err) {
    console.error('❌ Seeding failed:', err);
  } finally {
    process.exit(0);
  }
}

seed();
