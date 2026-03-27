# AI Workflow Platform — Master Context

**Purpose:** This file is the central source of truth for the AI Workflow Platform project. All engineers and AI agents working on this codebase must adhere to the architecture, database schema, and abstractions defined here.

**Last updated:** 2026-03-27

---

## 1. Project Overview

A web application for building, configuring, and orchestrating AI agents, tools, multi-agent tasks, and scheduled workflows. The system follows a "Tree of Workflows" pattern where high-level goals are broken into executable, predictable agents chained linearly through tasks, fired on schedules.

### Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 15 (App Router), Vanilla CSS |
| **Backend** | Node.js + Express (TypeScript, ESM) |
| **Database** | PostgreSQL via Supabase (transaction pooler) |
| **Queue** | Redis + BullMQ (for scheduling only) |
| **LLM** | Ollama (local, `llama3.2`) — OpenAI-compatible API at `localhost:11434/v1` |
| **LLM SDKs** | `openai` npm package (for Ollama + OpenAI + Groq), `@anthropic-ai/sdk` (for Anthropic) |
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
| 0 | `LLMProviderFactory` | Builds a `ChatProvider` for the configured backend (Ollama/OpenAI/Anthropic/Groq) |
| 1 | `AgentNode` | Stateless. Fetches agent definition + tools from DB, resolves provider via factory, runs agentic tool-use loop |
| 2 | `TaskNode` ✅ | Chains multiple `AgentNode`s linearly; passes outputs as inputs to next step |
| 3 | `SchedulerService` ✅ | Root trigger (cron/interval/one_time/manual); runs assigned `TaskNode` sequence via BullMQ |

### Execution Tracking

**In-Memory Registry** (apps/api/src/routes/task-runs.ts):
- All active executions tracked in local `Map<runId, AbortController>`
- Enables kill operations (abort signals)
- Simple, fast, no external dependencies
- Cleared on server restart (reconciliation marks orphaned runs as failed)

**Why not Redis for execution tracking?**
- BullMQ already uses Redis for job scheduling
- Execution tracking needs to be instant (local Map is O(1))
- Redis would add 100k+ unnecessary requests per day
- Single-server deployment doesn't need distributed tracking

### `ExecutionContext`
Passed explicitly to every `.execute()` call. Must be **strictly JSON-serializable**:
```typescript
{
  inputData: Record<string, unknown>  // agentId/taskId, runId, prompt, …
  currentDepth: number                // circuit breaker
  totalSteps: number
  maxDepth: number
  parentRunId: string | null
  abortSignal?: AbortSignal          // For kill operations
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
   - If tool calls → execute via `ToolRegistry.execute(name, args)`, append results as user messages, loop
5. Persist result to `execution_runs`

### TaskNode Linear Orchestrator (`src/engine/TaskNode.ts`) ✅ NEW
1. Load task from `tasks` table — reads `workflow_definition` (ordered step array)
2. Create parent `execution_run` record (`node_type='task'`)
3. For each step in order:
   - Create child `execution_run` (`node_type='agent'`, `parent_run_id=taskRunId`)
   - Build step prompt — injects previous step's output as context
   - Run `AgentNode.execute()` with step's `agentId`
   - On failure → mark task failed, stop chain
   - On success → collect output, pass to next step
4. Mark task `completed` with full chain output

**Step prompt construction:**
- Step 1: receives the task description + initial user prompt
- Step N+1: receives the task description + previous step's full text output
- This creates a natural "research → summarize → report" chain

### `LLMProviderFactory` (`src/engine/LLMProviderFactory.ts`)
Factory builds a `ChatProvider` from a config object (sourced from `llm_settings` DB row):

| Provider | Implementation | Notes |
|---|---|---|
| `ollama` / `llama-local` | `openai` npm package, `baseURL: localhost:11434/v1` | No API key needed |
| `openai` | `openai` npm package | Requires `api_key` |
| `groq` | `openai` npm package, `baseURL: api.groq.com/openai/v1` | Requires `api_key` |
| `anthropic` | `@anthropic-ai/sdk` | Requires `api_key`; handles `system` + `tool_use` blocks natively |
| `gemini` | `openai` npm package, `baseURL: generativelanguage.googleapis.com/v1beta/openai` | Requires `api_key` |

All providers adhere to the `ChatProvider` interface:
```typescript
chat(messages, tools?, options?): Promise<ChatResponse>
chatStream(messages, tools?, options?): AsyncGenerator<StreamChunk>
```

### `ToolRegistry` (`src/engine/ToolRegistry.ts`) ✅ REWRITTEN
Single source of truth for all tool definitions and execution. **No `builtins.ts` dependency.**

- All 7 built-in tool definitions and executors are defined **inline** in `ToolRegistry.ts`
- `ToolRegistry.seed()` upserts built-ins into the DB on server startup (`ON CONFLICT (name) DO NOTHING`)
- `ToolRegistry.execute(toolName, args, agentId?)` — DB-driven execution:
  1. Loads tool row (config, is_enabled) from the `tools` DB table
  2. If name matches a built-in executor → runs it (with DB config)
  3. If config has `endpoint`/`url` → HTTP dispatch (POST args as JSON)
  4. Otherwise → structured `terminal` error

**Built-in tools (seeded automatically):**

| Tool | Description |
|---|---|
| `exa_search` | High-quality AI-centric neural search via Exa API |
| `tavily_search` | Dedicated search engine optimized for AI agents |
| `duckduckgo_search` | Vanilla unauthenticated instant text search |
| `http_request` | Generic HTTP client — GET/POST/PUT/PATCH/DELETE with timeout |
| `calculator` | Safe JS math expression evaluator — allowlist-based |
| `read_file` | Read file contents with truncation support (`max_chars`) |
| `write_file` | Write/overwrite a file (idempotent) |
| `run_command` | Shell command executor — supports `allowed_commands` allowlist |
| `get_datetime` | Current timestamp in iso/unix/human/utc format |

**Error design:** All tool outputs use `error: 'recoverable' | 'terminal'` + `message` fields so the model can distinguish retryable from fatal failures.

> ⚠️ `builtins.ts` is now an empty stub — do not add code there. ToolRegistry.ts is the only source.

---

## 3. Database Schema (PostgreSQL / Supabase)

Schema is defined in `apps/api/src/db/schema.sql`. Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

### Tables

#### `llm_settings`
Stores provider configurations. One row per provider. `is_default = true` is used when an agent has no specific provider pinned.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `provider` | TEXT | `llama-local`, `ollama`, `openai`, `anthropic`, `gemini`, `groq`, `custom` |
| `api_key` | TEXT | Empty string for Ollama |
| `base_url` | TEXT | e.g. `http://localhost:11434/v1` |
| `model_name` | TEXT | e.g. `llama3.2`, `llama-3.3-70b-versatile` |
| `is_default` | BOOLEAN | Only one row can be `true` (partial unique index) |
| `extra_params` | JSONB | Future use |

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
| `name` | TEXT UNIQUE | Name must match built-in executor name for native execution |
| `description` | TEXT | Shown to the LLM as the tool's decision boundary |
| `schema` | JSONB | JSON Schema for the tool's input (passed to LLM as function spec) |
| `config` | JSONB | Key-value config (API keys, endpoints, timeouts, etc.) |
| `is_enabled` | BOOLEAN | Only enabled tools are offered to agents |
| `tool_group` | TEXT | Defines the category/grouping sidebar sections in the UI (e.g., "Search", "System") |

#### `agent_tools`
Join table — `(agent_id, tool_id)` composite PK.

#### `tasks` ✅
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | TEXT UNIQUE | |
| `description` | TEXT | Also used as context for LLM workflow generation |
| `workflow_definition` | JSONB | `Array<{ agentId, stepName, description, promptOverride? }>` |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

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
Single table recording every execution at every level. Parent-child tree: `schedule → task → agent`.

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
| POST | `/api/agents/:id/run` | Sync dry run `{ prompt }` — returns result |
| POST | `/api/agents/:id/stream` | SSE streaming run — emits `start`, `text`, `tool_start`, `tool_result`, `done`, `error` events |

### `/api/tools`
| Method | Path | Description |
|---|---|---|
| GET | `/api/tools` | List all tools (annotated with `is_builtin` flag) |
| GET | `/api/tools/:id` | Single tool (full schema + config) |
| POST | `/api/tools` | Create custom tool |
| PUT | `/api/tools/:id` | Update tool |
| DELETE | `/api/tools/:id` | Delete tool |

### `/api/tasks` ✅ NEW
| Method | Path | Description |
|---|---|---|
| GET | `/api/tasks` | List tasks with `step_count`, `last_run_status`, `last_run_at` |
| GET | `/api/tasks/:id` | Single task (full `workflow_definition`) |
| POST | `/api/tasks` | Create task `{ name, description, workflow_definition[] }` |
| PUT | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/tasks/:id/run` | Execute task `{ prompt? }` — runs all steps sync, returns full result |
| POST | `/api/tasks/generate-workflow` | LLM generates steps `{ description, agentIds[] }` → `{ steps[] }` |

### `/api/llm-settings`
| Method | Path | Description |
|---|---|---|
| GET | `/api/llm-settings` | List all provider configs (masks api_key → `has_key: boolean`) |
| GET | `/api/llm-settings/:id` | Single provider |
| PUT | `/api/llm-settings/:id` | Update provider config, model, base_url, default flag |
| POST | `/api/llm-settings` | Add new provider row |
| DELETE | `/api/llm-settings/:id` | Remove provider (clears agent references) |

---

## 5. Frontend Pages

| Page | Route | Status |
|---|---|---|
| Agents | `/agents` | ✅ Full CRUD + Dry Run + Streaming |
| Tools | `/tools` | ✅ Full CRUD — unified list, built-ins pre-seeded |
| Tasks | `/tasks` | ✅ Full CRUD + AI Workflow Generator + Run |
| Task Runs | `/task-runs` | ✅ Live execution tracker, polling with expanding timeline |
| Scheduler | `/scheduler` | ✅ Full CRUD + toggle + run now |
| Run History | `/history` | ✅ Unified task + schedule history (Table + Drawer) |
| LLM Settings | `/settings` | ✅ Full CRUD |

### Agents Page (`/agents`)
- Left sidebar: lists all agents grouped by `agent_group`; search filters by name or group
- **Identity card**: `name`, `agent_group`, `llm_provider_id` dropdown
- **Skill card**: textarea + "Upload .md file" button; Clear button
- **Tools card**: chip-select toggles for all enabled tools
- **Dry Run card**: appears only for saved agents; prompt → streaming output + token/latency stats

### Tools Page (`/tools`)
- Unified list — all DB tools (built-ins + custom) organized by `tool_group` in the sidebar.
- `BUILT-IN` badge on tools that map to a native executor
- Built-ins are seeded automatically on server startup — no install flow
- Click to configure (edit config, schema, enable/disable), edit group, `+` to create new

### Tasks Page (`/tasks`) ✅ NEW
- **Sidebar**: task list with last-run status badge (`completed`/`failed`/`running`), step count, time since last run
- **Task Identity card**: name + description (description used for LLM generation)
- **AI Workflow Generator card**: agent chip-select → LLM plans steps from description
- **Workflow Steps editor**: drag-to-reorder, add/remove, per-step agent selector + description
- **Agent flow preview**: `Agent A → Agent B → Agent C` visualization

### Task Runs Page (`/task-runs`) ✅ NEW
- **Live tracker**: Lists all tasks and their active or previous runs.
- **Robust Polling**: Adaptive frontend polling (3s active / 8s idle) protected with global try/catch to survive 429 rate limit errors without crashing the React application.
- **Detailed Execution Timeline**: Clicking a running/completed task card expands it downwards to visualize step-by-step progress, showing which agent is Waiting, Running (spinner), Completed, or Failed, along with exact durations (e.g., `Finished in 57s`).
- **Kill switch**: Safe UI button to abort running task cycles.

### Settings Page (`/settings`)
- Cards per LLM provider (Ollama, Groq, OpenAI, Anthropic, Gemini, Custom)
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
│   │   └── src/
│   │       ├── config.ts         # Typed env config
│   │       ├── index.ts          # Express entry + route mounting + ToolRegistry.seed()
│   │       ├── types.ts          # ExecutionContext, ExecutionResult, ToolDefinition, etc.
│   │       ├── db/
│   │       │   ├── client.ts     # pg Pool (Supabase SSL)
│   │       │   ├── migrate.ts    # Runs schema.sql
│   │       │   ├── seed.ts       # Seeds default llm_settings row
│   │       │   └── schema.sql    # Full PostgreSQL schema
│   │       ├── engine/
│   │       │   ├── AgentNode.ts          # Single-agent agentic loop
│   │       │   ├── TaskNode.ts           # ✅ Multi-agent linear orchestrator
│   │       │   ├── LLMProviderFactory.ts # Provider abstraction (Ollama/OpenAI/Anthropic/Groq/Gemini)
│   │       │   ├── ToolRegistry.ts       # Built-in definitions + DB-driven execution
│   │       │   └── builtins.ts           # ⚠️ EMPTY STUB — do not use
│   │       └── routes/
│   │           ├── agents.ts       # CRUD + /run + /stream
│   │           ├── tools.ts        # CRUD (built-ins pre-seeded, no install endpoint)
│   │           ├── tasks.ts        # ✅ CRUD + /run + /generate-workflow
│   │           └── llm-settings.ts # CRUD + default management
│   └── web/                       # Next.js 15 frontend (App Router)
│       └── src/
│           ├── app/
│           │   ├── layout.tsx
│           │   ├── agents/page.tsx    # ✅ Full
│           │   ├── settings/page.tsx  # ✅ Full
│           │   ├── tools/page.tsx     # ✅ Full
│           │   ├── tasks/page.tsx     # ✅ Full (Phase 3)
│           │   ├── scheduler/page.tsx # 🔲 Stub
│           │   └── history/page.tsx   # 🔲 Stub
│           ├── components/Sidebar.tsx
│           └── lib/api.ts            # AgentRow, ToolRow, TaskRow, WorkflowStep + fetch wrappers
└── packages/shared/src/types.ts      # Shared types
```

---

## 7. Developer Setup

```bash
# Pre-requisite: Ollama must be running locally
# Install: https://ollama.com
ollama pull llama3.2

# 1. Install dependencies
npm install

# 2. Fill .env (DATABASE_URL is required; Ollama needs no key)
# DATABASE_URL=postgresql://...  (Supabase transaction pooler)
# LLM_PROVIDER=ollama
# LLM_MODEL=llama3.2

# 3. Run DB migration (idempotent)
npm run db:migrate --workspace=apps/api

# 4. Start both servers
npm run dev:api   # → http://localhost:3001  (seeds built-in tools on startup)
npm run dev:web   # → http://localhost:3000
```

---

## 8. Implementation Phases

| Phase | Description | Status |
|---|---|---|
| 1 | Walking skeleton: monorepo, DB, AgentNode, API, basic UI | ✅ Complete |
| 2 | Tool Layer: DB-driven ToolRegistry, built-ins auto-seeded, tools page | ✅ Complete |
| 3 | **Orchestration**: `TaskNode` linear chaining, multi-agent runs, AI workflow generation | ✅ Complete |
| 4 | **Async dispatch**: Redis + BullMQ, non-blocking execution, Scheduler UI, unified Run History | ✅ Complete |
| 5 | **Observability**: deeper run tree browser, export, metrics | 🔲 |
| 6 | Vector DB: Milvus integration, semantic memory for agents | 🔲 |

---

## 9. Key Decisions & Notes

- **No model_name override per agent** — model is always sourced from `llm_settings`. Change the provider row to change the model.
- **Ollama is the default LLM** — exposes an OpenAI-compatible API at `localhost:11434/v1`. We use the `openai` npm package for all OAI-compatible providers (Ollama, Groq, OpenAI, Gemini).
- **`@anthropic-ai/claude-agent-sdk` removed** — it required a real Anthropic account subprocess and cannot be pointed at Ollama.
- **ToolRegistry is the single source of truth** — all tool definitions, executors, and seeding logic live in `ToolRegistry.ts`. `builtins.ts` is an empty stub.
- **Built-ins auto-seed on startup** — `ToolRegistry.seed()` is called in `index.ts` before the server starts accepting requests. Uses `ON CONFLICT (name) DO NOTHING` — safe to call repeatedly.
- **web_search uses terminal errors** — DuckDuckGo sometimes returns empty body (causes `SyntaxError` on `res.json()`). All failure paths return `error: 'terminal'` with explicit "do not retry" instructions to prevent the model from looping.
- **Task step prompts are context-aware** — Step 1 gets the task description + user prompt. All subsequent steps get the previous step's full output injected as context, enabling natural research → synthesize → report chains.
- **Execution tree is fully logged** — every `TaskNode` run creates a parent `execution_run` with child `execution_run` records per agent step, linked via `parent_run_id`. Ready for the Run History UI.
- **Kill signals override autonomous completion** — if `ctx.abortSignal?.aborted` fires inside `TaskNode` or `AgentNode`, the node saves partial output data but securely respects the DB's `.status = 'failed'` (set by the kill route) to prevent resurrected tasks.
- **API rate limits increased** — `express-rate-limit` inside `index.ts` allows 5000 requests to properly support the robust frontend interval loop fetching updates `taskRunsApi.get` for expanded active runs without returning 429 error bodies that break Next.js JSON parser.
- **agent_group** — field on agents used purely for UI sidebar grouping. Not used in execution. Supports auto-categorization via LLM.
- **Groq supported** — `groq` is a valid provider in `llm_settings`. Uses `openai` npm package with `baseURL: https://api.groq.com/openai/v1`.
- **Redis usage optimized** — BullMQ uses Redis for job scheduling only. Execution tracking uses in-memory Map for efficiency (no Redis calls). This reduces Redis usage by 99% and keeps us within free tier limits.
- **Execution registry is local-only** — All active run tracking uses in-memory Map. Simple, fast, no external dependencies. Reconciliation on startup marks orphaned runs as failed.
- **Collapsible agent groups** — Agent sidebar supports collapsing/expanding groups with agent count badges for better organization.
