# Migration Guide: LLM Provider Refactor

## Quick Start

### 1. Update Environment Variables

Update your `.env` file based on `.env.example`:

```bash
# Copy the new structure
cp .env.example .env.new

# Update with your values
# Then replace your .env
mv .env.new .env
```

Key changes:
- `LLM_PROVIDER` default is now `llama-local` (was `ollama`)
- New API key variables: `GROQ_API_KEY`, `GEMINI_API_KEY`
- New base URL variables for custom endpoints

### 2. Run Database Migration

```bash
# Connect to your database and run the migration
psql $DATABASE_URL -f apps/api/src/db/migrate-llm-providers.sql
```

Or manually:

```sql
-- Drop old constraint
ALTER TABLE llm_settings DROP CONSTRAINT IF EXISTS llm_settings_provider_check;

-- Add new constraint
ALTER TABLE llm_settings ADD CONSTRAINT llm_settings_provider_check 
  CHECK (provider IN ('llama-local','ollama','groq','gemini','openai','anthropic','custom'));

-- Update localhost entries to llama-local
UPDATE llm_settings 
SET provider = 'llama-local' 
WHERE provider = 'ollama' 
  AND (base_url LIKE '%localhost%' OR base_url LIKE '%127.0.0.1%');
```

### 3. Rebuild and Restart

```bash
# Install dependencies (if needed)
npm install

# Rebuild TypeScript
npm run build

# Restart the API server
npm run dev
```

## What Changed?

### Provider Names
- `ollama` (localhost) → `llama-local` (system-provided)
- `ollama` (cloud) → `ollama` (user-configured)
- New: `groq`, `gemini`, `custom`

### Configuration Priority
1. Database `llm_settings` table (per-agent or default)
2. Environment variables (`.env` file)
3. Factory defaults

### API Endpoints

New endpoints:
- `GET /api/llm-settings/providers` - List all supported providers
- `GET /api/llm-settings/provider-requirements/:provider` - Get provider requirements

## Testing the Migration

### 1. Check Default Provider

```bash
curl http://localhost:3001/api/llm-settings
```

Should show `llama-local` as default provider.

### 2. Test Provider Requirements

```bash
curl http://localhost:3001/api/llm-settings/provider-requirements/groq
```

Should return:
```json
{
  "data": {
    "requiresApiKey": true,
    "requiresBaseUrl": false,
    "defaultBaseUrl": "https://api.groq.com/openai/v1"
  }
}
```

### 3. Add a New Provider

```bash
curl -X POST http://localhost:3001/api/llm-settings \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "groq",
    "api_key": "your-groq-api-key",
    "model_name": "llama-3.3-70b-versatile",
    "is_default": false
  }'
```

### 4. Test Agent Execution

Create or update an agent to use the new provider, then execute it to verify it works.

### 5. Test Provider Management

```bash
# List providers
curl http://localhost:3001/api/llm-settings

# Add a provider
curl -X POST http://localhost:3001/api/llm-settings \
  -H "Content-Type: application/json" \
  -d '{"provider":"groq","api_key":"test-key","model_name":"llama-3.3-70b-versatile"}'

# Delete a provider (with safety checks)
curl -X DELETE http://localhost:3001/api/llm-settings/{provider-id}
```

Note: The DELETE endpoint includes safety features:
- Cannot delete the only provider
- Automatically reassigns default if deleting current default
- Updates agents using the deleted provider to use default

## Rollback Plan

If you need to rollback:

1. Restore your old `.env` file
2. Run this SQL:

```sql
ALTER TABLE llm_settings DROP CONSTRAINT IF EXISTS llm_settings_provider_check;
ALTER TABLE llm_settings ADD CONSTRAINT llm_settings_provider_check 
  CHECK (provider IN ('anthropic','openai','gemini','ollama'));

UPDATE llm_settings 
SET provider = 'ollama' 
WHERE provider = 'llama-local';
```

3. Restore old code from git

## Common Issues

### Issue: "Unknown LLM provider" error

**Solution**: Make sure you ran the database migration to update the constraint.

### Issue: "Provider requires an API key" error

**Solution**: Either:
- Add the API key to `.env` file
- Configure it in the database via the LLM Settings UI
- Use `llama-local` which doesn't require an API key

### Issue: Existing agents not working

**Solution**: Check the agent's `llm_provider_id`:
- If it points to an old 'ollama' entry, update it to 'llama-local'
- Or set the agent's `llm_provider_id` to NULL to use the default

## Support

For issues or questions:
1. Check the logs: `npm run dev` output
2. Review `Docs/LLM_Provider_Refactor.md` for architecture details
3. Check database: `SELECT * FROM llm_settings;`
