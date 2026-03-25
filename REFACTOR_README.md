# LLM Provider Refactor - Quick Reference

## 🎯 What Was Done

The backend core engine has been completely refactored to support multiple LLM providers with dynamic configuration while maintaining the factory design pattern.

## 📋 Quick Migration (3 Steps)

### 1. Update Environment Variables
```bash
# Copy new structure
cp .env.example .env
# Add your API keys
```

### 2. Run Database Migration
```bash
# Windows PowerShell
.\scripts\migrate-llm-providers.ps1

# Linux/Mac
./scripts/migrate-llm-providers.sh

# Or manually
psql $DATABASE_URL -f apps/api/src/db/migrate-llm-providers.sql
```

### 3. Rebuild & Restart
```bash
npm run build
npm run dev
```

## 🔧 Supported Providers

| Provider | Requires API Key | Requires Base URL | Notes |
|----------|-----------------|-------------------|-------|
| **llama-local** | ❌ | ❌ | System default, uses local Ollama |
| **ollama** | ❌ | ✅ | User-configured cloud instance |
| **groq** | ✅ | ❌ | Fast inference API |
| **gemini** | ✅ | ❌ | Google Gemini |
| **openai** | ✅ | ❌ | OpenAI GPT models |
| **anthropic** | ✅ | ❌ | Claude models |
| **custom** | ❌ | ✅ | Any OpenAI-compatible API |

## 📝 Key Changes

### Environment Variables
```env
# NEW DEFAULT
LLM_PROVIDER=llama-local  # was: ollama

# NEW API KEYS
GROQ_API_KEY=
GEMINI_API_KEY=

# NEW BASE URLS
OLLAMA_BASE_URL=
GROQ_BASE_URL=
GEMINI_BASE_URL=
CUSTOM_LLM_BASE_URL=
```

### Database Schema
- Provider constraint updated to include all new providers
- Default provider changed from 'ollama' to 'llama-local'

### API Endpoints (NEW)
```bash
# List all providers
GET /api/llm-settings/providers

# Get provider requirements
GET /api/llm-settings/provider-requirements/:provider

# Add new provider
POST /api/llm-settings
{
  "provider": "groq",
  "api_key": "your-key",
  "model_name": "llama-3.3-70b-versatile"
}

# Delete a provider (with safety checks)
DELETE /api/llm-settings/:id
```

### Frontend Features
- **Provider Management UI**: Add, edit, and delete providers
- **Delete with Confirmation**: Two-click delete with safety checks
- **Dynamic Forms**: API key and base URL fields shown based on provider requirements
- **Visual Feedback**: Connection status, default badge, confirmation states

## 📚 Documentation

- **[REFACTOR_SUMMARY.md](./REFACTOR_SUMMARY.md)** - Complete summary of all changes
- **[Docs/LLM_Provider_Refactor.md](./Docs/LLM_Provider_Refactor.md)** - Architecture details
- **[Docs/Migration_Guide.md](./Docs/Migration_Guide.md)** - Step-by-step migration guide

## 🧪 Testing

```bash
# 1. Check default provider
curl http://localhost:3001/api/llm-settings

# 2. Get provider requirements
curl http://localhost:3001/api/llm-settings/provider-requirements/groq

# 3. Add a provider
curl -X POST http://localhost:3001/api/llm-settings \
  -H "Content-Type: application/json" \
  -d '{"provider":"groq","api_key":"your-key","model_name":"llama-3.3-70b-versatile"}'

# 4. Delete a provider
curl -X DELETE http://localhost:3001/api/llm-settings/{provider-id}
```

## 🏗️ Architecture

```
┌─────────────────┐
│   AgentNode     │  (Unchanged - decoupled via factory)
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│   LLMProviderFactory.create()      │  (Refactored)
│   - Dynamic provider selection      │
│   - Requirement validation          │
│   - API key/URL resolution          │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│   ChatProvider Interface            │
│   ├─ OpenAI-compatible (Groq, etc) │
│   └─ Anthropic native SDK           │
└─────────────────────────────────────┘
```

## ✅ Benefits

1. **Flexibility** - Add providers without code changes
2. **Security** - API keys in database, not hardcoded
3. **Scalability** - Easy to add new providers
4. **Maintainability** - Factory pattern keeps code clean
5. **UX** - Dynamic UI based on provider requirements

## 🆘 Troubleshooting

### "Unknown LLM provider" error
→ Run the database migration script

### "Provider requires an API key" error
→ Add API key to `.env` or configure in database

### Existing agents not working
→ Check agent's `llm_provider_id` points to valid provider

## 📞 Support

Check the logs and review documentation:
- `npm run dev` output
- `Docs/Migration_Guide.md`
- Database: `SELECT * FROM llm_settings;`
