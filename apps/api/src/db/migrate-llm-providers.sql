-- Migration: Add support for new LLM providers
-- Run this to update existing databases with new provider support

-- 1. Drop the old constraint
ALTER TABLE llm_settings DROP CONSTRAINT IF EXISTS llm_settings_provider_check;

-- 2. Add new constraint with all supported providers
ALTER TABLE llm_settings ADD CONSTRAINT llm_settings_provider_check 
  CHECK (provider IN ('llama-local','ollama','groq','gemini','openai','anthropic','custom'));

-- 3. Update existing 'ollama' entries to 'llama-local' if they're using localhost
UPDATE llm_settings 
SET provider = 'llama-local' 
WHERE provider = 'ollama' 
  AND (base_url LIKE '%localhost%' OR base_url LIKE '%127.0.0.1%');

-- 4. Ensure default provider exists
INSERT INTO llm_settings (provider, model_name, is_default, base_url, api_key)
VALUES ('llama-local', 'llama3.2', true, 'http://localhost:11434/v1', 'not-required')
ON CONFLICT DO NOTHING;

-- 5. If no default exists, set llama-local as default
UPDATE llm_settings 
SET is_default = true 
WHERE provider = 'llama-local' 
  AND NOT EXISTS (SELECT 1 FROM llm_settings WHERE is_default = true);
