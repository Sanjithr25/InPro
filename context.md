# AI Workflow Platform — Master Context

**Purpose:** This file is the central source of truth for the AI Workflow Platform project. All engineers and AI agents working on this codebase must adhere to the architecture, database schema, and abstractions defined here.

**Last updated:** 2026-03-24

---

## 1. Project Overview

A web application for building, configuring, and orchestrating AI agents, tools, multi-agent tasks, and scheduled workflows. The system follows a "Tree of Workflows" pattern where high-level goals are broken into executable, predictable agents chained linearly through tasks, fired on schedules.

### Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 15 (App Router), Vanilla CSS |
| **Backend** | Node.js + Express (TypeScript, ESM) |
| **Database** | PostgreSQL via Supabase (transaction pooler) |
| **LLM** | Ollama (local, `llama3.2`) — OpenAI-compatible API at `localhost:11434/v1` |
| **LLM SDKs** | `openai` npm package (for Ollama + OpenAI), `@anthropic-ai/sdk` (for Anthropic) |
| **Queue (planned)** | Redis + BullMQ (Phase 4) |
| **Vector DB (planned)** | Milvus (Phase 5+) |

> ⚠️ The `@anthropic-ai/claude-agent-sdk` has been **removed**. It spawned `claude code` as a subprocess requiring a real Anthropic account. All agent execution is now driven by our own agentic loop in `AgentNode.ts`.

---

## 2. Core Execution Engine

### `IExecutableNode` interface
All runnable entities implement:
```typescript
execute(context: ExecutionContext): Promise<ExecutionResult>
```

### Node Hierarchy

| Level | Class | Role |
|---|---|---|
| 0 | `LLMProviderFactory` | Builds a `ChatProvider` for the configured backend (Ollama/OpenAI/Anthropic) |
| 1 | `AgentNode` | Stateless. Fetches agent definition + tools from DB, resolves provider via factory, runs agentic tool-use loop |
| 2 | `TaskNode` *(planned Phase 3)* | Chains multiple `AgentNode`s linearly; passes outputs as inputs |
| 3 | `ScheduleNode` *(planned Phase 4)* | Root trigger (cron/webhook/manual); runs assigned `TaskNode` sequence |

### `ExecutionContext`
Passed explicitly to every `.execute()` call. Must be **strictly JSON-serializable** (no DB connections, no class instances — it will cross the Redis queue boundary in Phase 4):
```typescript
{
  inputData: Record<string, unknown>  // agentId, runId, prompt, …
  currentDepth: number                // circuit breaker
  totalSteps: number
  maxDepth: number
  parentRunId: string | null
}
```

### AgentNode Agentic Loop (`src/engine/AgentNode.ts`)
1. Fetch agent definition from `agents` table
2. Fetch enabled tools from `tools` via `agent_tools` join
3. Resolve LLM provider:
   - If agent has `llm_provider_id` → load that `llm_settings` row
   - Else → load the `is_default = true` row from `llm_settings`
   - Pass `provider`, `apiKey`, `model`, `baseUrl` to `LLMProviderFactory.create()`
4. Run tool-use loop (up to `MAX_TURNS = 15`):
   - Call `llm.chat(messages, tools)`
   - If `stopReason === 'end_turn'` → done
   - If tool calls → execute via `ToolRegistry`, append results as user messages, loop
5. Persist result to `execution_runs`

### `LLMProviderFactory` (`src/engine/LLMProviderFactory.ts`)
Factory builds a `ChatProvider` from a config object (sourced from `llm_settings` DB row):

| Provider | Implementation | Notes |
|---|---|---|
| `ollama` | `openai` npm package, `baseURL: localhost:11434/v1` | No API key needed |
| `openai` | `openai` npm package, `baseURL` from `llm_settings.base_url` | Requires `api_key` |
| `anthropic` | `@anthropic-ai/sdk` | Requires `api_key`; handles `system` + `tool_use` blocks natively |

All providers adhere to the `ChatProvider` interface:
```typescript
chat(messages, tools?, options?): Promise<ChatResponse>
```

### `ToolRegistry` (`src/engine/ToolRegistry.ts`)
- **Phase 1 stub** — returns a placeholder response for any tool call
- Phase 2 will load real handler modules, decrypt `tools.config`, and call the actual integration

---

## 3. Database Schema (PostgreSQL / Supabase)

Schema is defined in `apps/api/src/db/schema.sql`. Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

### Tables

#### `llm_settings`
Stores provider configurations. One row per provider. `is_default = true` is used when an agent has no specific provider pinned.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `provider` | TEXT | `ollama`, `openai`, `anthropic`, `gemini` |
| `api_key` | TEXT | Empty string for Ollama |
| `base_url` | TEXT | e.g. `http://localhost:11434/v1` |
| `model_name` | TEXT | e.g. `llama3.2` |
| `is_default` | BOOLEAN | Only one row can be `true` (partial unique index) |
| `extra_params` | JSONB | Future use |

**Active default:** `ollama` / `llama3.2` / `http://localhost:11434/v1`

#### `agents`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT UNIQUE | |
| `skill` | TEXT | System prompt (raw text or .md content) |
| `llm_provider_id` | UUID FK → `llm_settings` | NULL = use default |
| `agent_group` | TEXT | Groups agents in the UI sidebar (e.g. "Finance", "Research") |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

> ⚠️ `model_name` column has been **dropped**. Model is always sourced from `llm_settings`.

#### `tools`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT UNIQUE | |
| `description` | TEXT | Shown to the LLM |
| `schema` | JSONB | JSON Schema for the tool's input (passed to LLM as function spec) |
| `config` | JSONB | API keys / integration config (should be encrypted in Phase 3+) |
| `is_enabled` | BOOLEAN | Only enabled tools are offered to agents |

#### `agent_tools`
Join table — `(agent_id, tool_id)` composite PK.

#### `tasks`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT UNIQUE | |
| `description` | TEXT | |
| `workflow_definition` | JSONB | Ordered array of `{ agentId, stepName, description }` |

#### `schedules`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT UNIQUE | |
| `trigger_type` | TEXT | `cron`, `interval`, `one_time`, `webhook`, `manual` |
| `trigger_config` | JSONB | e.g. `{ cron: "0 9 * * *" }` |
| `is_enabled` | BOOLEAN | |

#### `schedule_tasks` 
Join table with `order_index` for execution ordering.

#### `execution_runs` (Polymorphic Logger)
Single table recording every execution at every level.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `node_type` | TEXT | `agent`, `task`, `schedule` |
| `node_id` | UUID | Polymorphic FK |
| `parent_run_id` | UUID FK → self | Creates tree: schedule → task → agent |
| `status` | TEXT | `pending`, `running`, `completed`, `failed` |
| `input_data` | JSONB | |
| `output_data` | JSONB | |
| `error_message` | TEXT | |
| `started_at` / `ended_at` | TIMESTAMPTZ | |

---

## 4. API Routes

All routes are under the Express API at `http://localhost:3001`.

### `/api/agents`
| Method | Path | Description |
|---|---|---|
| GET | `/api/agents` | List all agents (with joined provider info) |
| GET | `/api/agents/:id` | Get single agent with tools array |
| POST | `/api/agents` | Create agent `{ name, skill, agent_group, llm_provider_id?, tool_ids[] }` |
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |
| POST | `/api/agents/:id/run` | Dry run `{ prompt }` — runs agentic loop, returns result synchronously |

### `/api/tools`
| Method | Path | Description |
|---|---|---|
| GET | `/api/tools` | List all tools |
| POST | `/api/tools` | Create tool |
| PUT | `/api/tools/:id` | Update tool |
| DELETE | `/api/tools/:id` | Delete tool |

### `/api/llm-settings`
| Method | Path | Description |
|---|---|---|
| GET | `/api/llm-settings` | List all provider configs (masks api_key → `has_key: boolean`) |
| PUT | `/api/llm-settings/:id` | Update provider config, model, base_url, default flag |
| POST | `/api/llm-settings` | Add new provider row |

---

## 5. Frontend Pages

| Page | Route | Status |
|---|---|---|
| Agents | `/agents` | ✅ Full CRUD + Dry Run |
| Tools | `/tools` | 🔲 Next up |
| Tasks | `/tasks` | 🔲 Stub |
| Scheduler | `/scheduler` | 🔲 Stub |
| Run History | `/history` | 🔲 Stub |
| LLM Settings | `/settings` | ✅ Full CRUD |

### Agents Page (`/agents`) — current state
- **Left sidebar**: lists all agents grouped by `agent_group`; search filters by name or group
- **Identity card**: `name`, `agent_group` (for sidebar grouping), `llm_provider_id` (dropdown showing all configured providers with default clearly labeled)
- **Skill card**: textarea + "Upload .md file" button (populates textarea); Clear button
- **Tools card**: chip-select toggles for all enabled tools
- **Dry Run card**: appears only for saved agents; runs prompt and shows output + token/latency stats

### Settings Page (`/settings`) — current state
- Cards for each configured LLM provider (Ollama, OpenAI, Anthropic, Gemini)
- Groq has been removed entirely
- Fields: API Key (masked), Base URL, Model Name, Set as Default
- Add New Provider button

---

## 6. Monorepo Structure

```
InPro/
├── .env                          # Secrets (not committed)
├── context.md                    # ← This file
├── apps/
│   ├── api/                      # Node.js/Express backend (TypeScript, ESM)
│   │   ├── package.json
│   │   ├── scripts/
│   │   │   └── alter_agent.ts    # One-off DB migration scripts
│   │   └── src/
│   │       ├── config.ts         # Typed env config (LLM_PROVIDER=ollama, LLM_MODEL=llama3.2)
│   │       ├── index.ts          # Express entry + route mounting
│   │       ├── types.ts          # ExecutionContext, ExecutionResult, LLMProviderName, DB row types
│   │       ├── db/
│   │       │   ├── client.ts     # pg Pool (Supabase SSL)
│   │       │   ├── migrate.ts    # Runs schema.sql
│   │       │   ├── seed.ts       # Seeds Ollama as default llm_settings
│   │       │   └── schema.sql    # Full PostgreSQL schema
│   │       ├── engine/
│   │       │   ├── AgentNode.ts           # Agentic loop (no subprocess)
│   │       │   ├── LLMProviderFactory.ts  # Factory: ollama|openai|anthropic
│   │       │   └── ToolRegistry.ts        # Phase 1 stub
│   │       └── routes/
│   │           ├── agents.ts       # CRUD + /run
│   │           ├── tools.ts        # CRUD
│   │           └── llm-settings.ts # CRUD + default mgmt
│   └── web/                       # Next.js 15 frontend (App Router)
│       └── src/
│           ├── app/
│           │   ├── layout.tsx
│           │   ├── agents/page.tsx   # ✅ Full
│           │   ├── settings/page.tsx # ✅ Full
│           │   ├── tools/page.tsx    # 🔲 Next
│           │   ├── tasks/page.tsx    # 🔲 Stub
│           │   ├── scheduler/page.tsx
│           │   └── history/page.tsx
│           ├── components/Sidebar.tsx
│           └── lib/api.ts            # AgentRow, ToolRow, LlmSettingRow + fetch wrappers
└── packages/shared/src/types.ts     # Shared types
```

---

## 7. Developer Setup

```bash
# Pre-requisite: Ollama must be running locally
# Install: https://ollama.com
ollama pull llama3.2

# 1. Install dependencies
npm install

# 2. Fill .env (only DATABASE_URL is strictly required; Ollama needs no key)
# DATABASE_URL=postgresql://...  (Supabase transaction pooler)
# LLM_PROVIDER=ollama
# LLM_MODEL=llama3.2

# 3. Run DB migration (idempotent)
npm run db:migrate --workspace=apps/api

# 4. (Optional) Seed default Ollama provider row
npx tsx apps/api/src/db/seed.ts

# 5. Start both servers
npm run dev:api   # → http://localhost:3001
npm run dev:web   # → http://localhost:3000
```

---

## 8. Implementation Phases

| Phase | Description | Status |
|---|---|---|
| 1 | Walking skeleton: monorepo, DB, AgentNode, API, basic UI | ✅ Complete |
| 2 | **Tool Layer**: real ToolRegistry, tool CRUD UI, dynamic JSON schema → LLM | 🔄 In progress |
| 3 | Orchestration: `TaskNode` linear chaining, end-to-end task dry runs | 🔲 |
| 4 | Async dispatch: Redis + BullMQ, non-blocking frontend polling | 🔲 |
| 5 | Observability: Run History UI, polymorphic execution_runs tree rendering | 🔲 |

---

## 9. Key Decisions & Notes

- **No model_name override per agent** — model is always sourced from `llm_settings`. Change the provider row to change the model.
- **Ollama is the default LLM** — exposes a native Anthropic Messages API at `localhost:11434` (v0.14+) AND an OpenAI-compatible API at `localhost:11434/v1`. We use the OAI-compatible endpoint via the `openai` npm package.
- **`@anthropic-ai/claude-agent-sdk` removed** — it required a real Anthropic account subprocess and cannot be pointed at Ollama.
- **DB migrations via scripts**: one-off schema changes go in `apps/api/scripts/` as TypeScript files run with `npx tsx`.
- **Groq fully removed**: from types, Zod enums, schema CHECK constraints, seed data, UI, and `.env` defaults.
- **agent_group**: new field on agents. Used purely for UI grouping in the sidebar. Not used in execution.
