# LLM Provider Refactor Documentation

## Overview

The backend has been refactored to support multiple LLM providers with a flexible, dynamic configuration system. The factory design pattern is maintained for dynamic agent building, while adding support for user-configured providers.

## Supported Providers

### System-Provided
- **llama-local**: Local Llama model (default, no API key required)
  - Default base URL: `http://localhost:11434/v1`
  - Uses Ollama locally

### User-Configurable
- **ollama**: User-configured Ollama cloud instances
  - Requires: Base URL
  - Optional: API key
  
- **groq**: Groq fast inference API
  - Requires: API key
  - Default base URL: `https://api.groq.com/openai/v1`
  
- **gemini**: Google Gemini API
  - Requires: API key
  - Default base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`
  
- **openai**: OpenAI GPT models
  - Requires: API key
  
- **anthropic**: Anthropic Claude models
  - Requires: API key
  
- **custom**: Any OpenAI-compatible endpoint
  - Requires: Base URL
  - Optional: API key

## Architecture Changes

### 1. Database Schema (`apps/api/src/db/schema.sql`)
- Updated `llm_settings` table to support new providers
- Changed default provider from 'ollama' to 'llama-local'
- Provider constraint now includes: `llama-local`, `ollama`, `groq`, `gemini`, `openai`, `anthropic`, `custom`

### 2. LLM Provider Factory (`apps/api/src/engine/LLMProviderFactory.ts`)
- Added `PROVIDER_REQUIREMENTS` map for dynamic validation
- Implemented `getRequirements()` method for UI/validation
- Added `resolveApiKey()` and `resolveBaseUrl()` helper methods
- All OpenAI-compatible providers (groq, gemini, ollama, custom) use the same adapter
- Anthropic uses native SDK

### 3. Configuration (`apps/api/src/config.ts`)
- Added support for all provider API keys
- Added base URL configuration for each provider
- Environment variables serve as fallback if not in database

### 4. Types (`apps/api/src/types.ts` & `packages/shared/src/types.ts`)
- Updated `LLMProviderName` type to include all providers
- Added `ProviderRequirements` interface
- Made `apiKey` optional in `LLMProviderConfig`

### 5. API Routes (`apps/api/src/routes/llm-settings.ts`)
- Added `GET /api/llm-settings/providers` - List all supported providers
- Added `GET /api/llm-settings/provider-requirements/:provider` - Get requirements for a specific provider
- Added `DELETE /api/llm-settings/:id` - Delete a configured LLM provider
- Updated validation schemas to include new providers

## Environment Variables

All API keys and base URLs can be configured in `.env`:

```env
# Default provider
LLM_PROVIDER=llama-local
LLM_MODEL=llama3.2

# API Keys (fallback if not in DB)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=

# Base URLs (optional overrides)
OLLAMA_BASE_URL=
GROQ_BASE_URL=
GEMINI_BASE_URL=
CUSTOM_LLM_BASE_URL=
```

## Migration

For existing databases, run the migration script:

```bash
psql $DATABASE_URL -f apps/api/src/db/migrate-llm-providers.sql
```

This will:
1. Update the provider constraint
2. Convert localhost Ollama entries to 'llama-local'
3. Ensure a default provider exists

## Usage

### Adding a New Provider via API

```typescript
POST /api/llm-settings
{
  "provider": "groq",
  "api_key": "gsk_...",
  "model_name": "llama-3.3-70b-versatile",
  "is_default": false
}
```

### Deleting a Provider

```typescript
DELETE /api/llm-settings/:id
```

The delete endpoint includes safety checks:
- Prevents deletion of the only provider
- Automatically sets another provider as default if deleting the current default
- Updates agents using the deleted provider to use the default instead
- Returns information about affected agents

### Checking Provider Requirements

```typescript
GET /api/llm-settings/provider-requirements/groq
// Returns:
{
  "data": {
    "requiresApiKey": true,
    "requiresBaseUrl": false,
    "defaultBaseUrl": "https://api.groq.com/openai/v1"
  }
}
```

### Agent Execution Flow

1. Agent loads from database with optional `llm_provider_id`
2. If `llm_provider_id` exists, load that provider's settings
3. Otherwise, use the default provider from `llm_settings` where `is_default = true`
4. `LLMProviderFactory.create()` validates requirements and creates the appropriate provider
5. Agent executes using the configured provider

## Dynamic Provider Configuration

The UI can dynamically:
1. Fetch list of supported providers: `GET /api/llm-settings/providers`
2. Check requirements for selected provider: `GET /api/llm-settings/provider-requirements/:provider`
3. Show/hide API key and base URL fields based on requirements
4. Validate before submission
5. Delete providers with safety checks and confirmation

### Delete Provider UI Flow

1. User clicks "Delete" button on a provider card
2. Button changes to "Confirm Delete?" with danger styling (red)
3. User clicks again to confirm
4. Backend performs safety checks:
   - Prevents deletion if it's the only provider
   - Auto-reassigns default if deleting current default
   - Updates agents using the deleted provider to use default
5. Success message shows number of affected agents
6. Provider card is removed from UI

## Factory Design Pattern

The factory pattern is preserved:
- `LLMProviderFactory.create()` returns a `ChatProvider` interface
- All providers implement the same interface
- `AgentNode` remains decoupled from specific LLM SDKs
- New providers can be added by:
  1. Adding to `LLMProviderName` type
  2. Adding requirements to `PROVIDER_REQUIREMENTS`
  3. Implementing provider logic in factory's switch statement

## Testing

Test different providers:

```typescript
// Test llama-local (default)
const provider1 = LLMProviderFactory.create();

// Test groq
const provider2 = LLMProviderFactory.create({
  provider: 'groq',
  apiKey: 'gsk_...',
  model: 'llama-3.3-70b-versatile'
});

// Test custom endpoint
const provider3 = LLMProviderFactory.create({
  provider: 'custom',
  baseUrl: 'https://my-llm-api.com/v1',
  apiKey: 'optional-key',
  model: 'my-model'
});
```

## Benefits

1. **Flexibility**: Users can add any provider without code changes
2. **Security**: API keys stored in database, not hardcoded
3. **Scalability**: Easy to add new providers
4. **Maintainability**: Factory pattern keeps code clean
5. **User Experience**: Dynamic UI based on provider requirements
6. **Backward Compatible**: Existing agents continue to work
