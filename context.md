# AI Workflow Platform: Master Agent Context

**Purpose:** This file (`agent.md`) is the central source of truth for the entire AI Workflow Platform project. Anytime an AI agent or engineer is modifying, scaffolding, or debugging the codebase, they MUST adhere to the architectural constraints, database schemas, and abstractions defined below.

---

## 1. Project Overview & Boundaries
A web application for managing AI agents, tools, tasks, and scheduled workflows. 
The system operates on an orchestrated "Tree of Workflows" pattern where abstract goals are translated into executable, predictable jobs managed via stateless message queues.

### Tech Stack Constraints
*   **Frontend:** React/Next.js (Dashboard for Agents, Tools, Tasks, Run History).
*   **Backend:** Node.js (API Gateway + Headless Execution Workers).
*   **Message Queue:** Redis (BullMQ / Celery equivalent) for isolating LLM API calls and handling retry logic.
*   **Databases:**
    1.  **PostgreSQL:** Relational source of truth (Schedules, Tasks, Log Streams).
    2.  **Milvus:** Vector search and persistent multi-agent memory.
    3.  **Redis:** Fast queue management.

---

## 2. Core Execution Abstraction (The Engine)
The core of the backend is the `IExecutableNode` abstraction. **Every node in the execution graph uses this exact same typescript/node abstraction.** 

### `src/engine/IExecutableNode.ts`
All runnable entities implement this interface:
*   `execute(context: ExecutionContext): Promise<ExecutionResult>`

### Node Hierarchy (The Fractal Tree)
1.  **Level 0: `ClaudeAgentWrapper`** 
    *   The raw SDK wrapper. Handles the conversional loop, parses system prompts from `.md` files, and dispatches dynamic tool calls.
2.  **Level 1: `AgentNode`** 
    *   Implements `IExecutableNode`. 
    *   A stateless configuration wrapper. At runtime, it queries the DB for its allowed tools and system prompt, passes them down to `ClaudeAgentWrapper`, and returns the LLM's final parsed output.
3.  **Level 2: `TaskNode`**
    *   Implements `IExecutableNode`.
    *   A runtime orchestrator that acts like a "Manager Agent". It takes a sequence of `AgentNode` references and runs them linearly. 
    *   **Crucial Rule:** Tasks DO NOT share a global DB memory. Agent 1's `ExecutionResult` is explicitly passed as `ExecutionContext.InputData` to Agent 2.
4.  **Level 3: `TaskGroupNode` (Schedule)**
    *   Implements `IExecutableNode`.
    *   The root trigger (driven by a Cron daemon, webhook, or manual fire). Loops over its assigned `TaskNode` sequence and triggers `.execute()`.

### The `ExecutionContext.ts`
Passed explicitly during every `execute` call:
*   `InputData`: The payload to act upon.
*   `currentDepth` & `totalSteps`: Fast circuit breakers. Hard `MAX_DEPTH` limit enforces safety against infinite LLM tool-calling loops.
*   Must be strictly **JSON-serializable**. Cannot contain DB connections or instantiated classes because the ExecutionContext crosses Redis queue boundaries between Node executions.

---

## 3. Database Schema (PostgreSQL)

The database strictly separates **Definitions** (What exists) from **Executions** (What happened).
*Agents, Tools, and Tasks are linked dynamically at runtime so that a 9:00 AM Cron trigger pulls the absolute latest system prompt or API Key for an Agent.*

### Table Definitions
*   **`agents`**: `id` (PK), `name`, `skill` (Text), `llm_provider_id` (FK), `model_name`.
*   **`tools`**: `id` (PK), `name`, `schema` (JSONB), `config` (JSONB encrypted).
*   **`agent_tools`**: Join table mapping agents to permitted tools.
*   **`tasks`**: `id` (PK), `name`, `description`, `workflow_definition` (JSONB DAG defining the `agentId` sequence).
*   **`schedules`**: `id` (PK), `name`, `trigger_type` (Enum), `trigger_config` (JSONB), `is_enabled`.
*   **`schedule_tasks`**: Join table defining execution order of Tasks within a Schedule.
*   **`llm_settings`**: Global provider settings.

### The Polymorphic Execution Logger
*   **`execution_runs`**: This single table is the holy grail of our UI. It records *every* time a node executes (Schedule, Task, or Agent).
    *   `id` (PK)
    *   `node_type` (Enum: `agent`, `task`, `schedule`)
    *   `node_id` (Polymorphic FK)
    *   `parent_run_id` (FK to `execution_runs.id`). **This creates the nested tree structure allowing the UI to render grouped UI progress bars on the "Run History" page.**
    *   `status` (`pending`, `running`, `completed`, `failed`)
    *   `input_data` (JSONB), `output_data` (JSONB), `started_at`, `ended_at`.

### Database Optimizations
*   **Foreign Keys:** Indexes placed on `agent_tools.agent_id` and `schedule_tasks.schedule_id`.
*   **Tree Traversal:** `CREATE INDEX idx_exec_runs_parent ON execution_runs(parent_run_id);`
*   **Poll Index:** `CREATE INDEX idx_exec_runs_pending ON execution_runs(status) WHERE status IN ('pending', 'running');`

---

## 4. Safety & Resilience Principles
When writing or reviewing code for this project, adhere to these checks:
1.  **Idempotent Resumes:** Before `AgentNode` or `TaskNode` executes, check the database for `status = 'completed'` under its `parent_run_id`. If found, skip execution and return the cached output. (Saves $$ and API limits on partial task failures).
2.  **Stateless Queuing:** Never attempt to stuff instances of classes (e.g. `new TaskNode()`) into the Redis queue. Push raw JSON params. The receiving headless worker uses a factory to re-hydrate the class.
3.  **Strict Isolation:** Agents do not share scope. Only the outputs explicitly yielded by an executed node become the context inputs for the next scheduled node.

---

## 5. Implementation Roadmap Phases
When starting a new feature, verify what phase of the roadmap you are on:
1.  **Phase 1: Walking Skeleton** ✅ COMPLETE — Monorepo scaffold, DB schema (Supabase), `LLMProviderFactory` (Groq via OpenAI-compatible SDK), `AgentNode` (factory + idempotent resume), Express API routes, Next.js 15 frontend (Page 1 + Page 6). **Pending**: fill `.env` with real creds then run `npm run db:migrate`.
2.  **Phase 2: Tool Layer** - Build ToolRegistry, parse dynamic JSON tool schemas over to the LLM.
3.  **Phase 3: Orchestration** - Implement the linear `TaskNode`. End-to-end dry run of a Task.
4.  **Phase 4: Async Dispatch** - Introduce Redis. Rip out synchronous execution. Frontend listens for status updates instead of blocking HTTP requests.
5.  **Phase 5: Observability** - Map the polymorphic `execution_runs` logging back to Page 5 Run History UI.

---

## 6. Monorepo Structure (Phase 1)
```
InPro/
├── apps/
│   ├── api/                      # Node.js/Express backend
│   │   └── src/
│   │       ├── config.ts         # Typed env config
│   │       ├── index.ts          # Express entry point
│   │       ├── db/
│   │       │   ├── client.ts     # pg Pool (Supabase SSL)
│   │       │   ├── migrate.ts    # Migration runner
│   │       │   └── schema.sql    # Full PostgreSQL schema
│   │       ├── engine/
│   │       │   ├── LLMProviderFactory.ts  # Factory: groq|anthropic|openai
│   │       │   ├── AgentNode.ts           # IExecutableNode Level 1
│   │       │   └── ToolRegistry.ts        # Phase 1 stub
│   │       └── routes/
│   │           ├── agents.ts      # CRUD + /run dry run
│   │           ├── tools.ts       # CRUD
│   │           └── llm-settings.ts # CRUD + default mgmt
│   └── web/                      # Next.js 15 frontend
│       └── src/
│           ├── app/
│           │   ├── layout.tsx    # Root layout + sidebar
│           │   ├── page.tsx      # Redirect → /agents
│           │   ├── agents/page.tsx  # Page 1: Agent Management
│           │   ├── settings/page.tsx # Page 6: LLM Settings
│           │   └── [tools|tasks|scheduler|history]/page.tsx  # Stubs
│           ├── components/Sidebar.tsx
│           └── lib/api.ts        # Typed fetch wrappers
└── packages/shared/src/          # Shared TS types
    └── types.ts                  # IExecutableNode, ExecutionContext, DB rows
```

## 7. Developer Setup
```bash
# Pre-requisite: fill .env with real credentials first!
# Required: DATABASE_URL (Supabase transaction pooler URL)
# Required: GROQ_API_KEY  (get free key at console.groq.com)

# 1. Copy env and fill credentials
cp .env.example .env
# Edit .env: set DATABASE_URL and GROQ_API_KEY

# 2. Run DB migration (idempotent — safe to re-run)
npm run db:migrate

# 3. Start API on port 3001
npm run dev:api

# 4. Start frontend on port 3000
npm run dev:web
```

## 8. Known Issues / Notes
- `tools.ts` routes use `return res.xxx()` pattern from original scaffold — re-run type check after Phase 2 if errors appear.
- `ToolRegistry` is a stub in Phase 1; all tool calls return a placeholder response.
- `AnthropicProvider` in `LLMProviderFactory.ts` is a placeholder stub for Phase 2.
- DB migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
