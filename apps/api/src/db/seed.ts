import db from './client.js';
import { v4 as uuidv4 } from 'uuid';

async function seed() {
  console.log('🌱 Seeding database...');
  
  try {
    // 1. Secret/LLM Settings for Ollama
    await db.query(`DELETE FROM llm_settings WHERE provider = $1`, ['ollama']);
    const providerId = uuidv4();
    await db.query(`
      INSERT INTO llm_settings (id, provider, api_key, model_name, is_default, base_url)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [providerId, 'ollama', 'ollama-local', 'llama3.2', true, 'http://localhost:11434/v1']);
    
    console.log('✅ LLM settings seeded');

    // 2. Test Agent
    const agentId = uuidv4();
    await db.query(`
      INSERT INTO agents (id, name, skill, llm_provider_id, model_name)
      VALUES ($1, $2, $3, $4, $5)
    `, [agentId, 'Test Agent', 'You are a helpful assistant.', providerId, 'llama3.2']);
    
    console.log('✅ Test agent seeded:', agentId);

  } catch (err) {
    console.error('❌ Seeding failed:', err);
  } finally {
    process.exit(0);
  }
}

seed();
