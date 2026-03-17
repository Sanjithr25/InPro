# Database Schema Design: AI Workflow Platform

To support the fractal execution tree (Agents, Tasks, Schedules) and ensure performance and referential integrity, we will use **PostgreSQL**.

The schema relies on a clear separation between **Definitions** (the templates of what *can* be run) and **Executions** (the logs of what *has* been run).

---

## 1. Core Entities (Definitions)

### `agents`
Represents Level 1 nodes (The Workers).
*   `id` (UUID, PK)
*   `name` (String, unique)
*   `skill` (Text) - The system prompt/markdown.
*   `llm_provider_id` (UUID, FK) - Link to specific LLM Settings.
*   `model_name` (String)

### `tools`
Represents the available functions an agent can use.
*   `id` (UUID, PK)
*   `name` (String, unique)
*   `schema` (JSONB) - The JSON schema describing the tool parameters.
*   `config` (JSONB, Encrypted) - API keys, endpoints.

### `agent_tools` (Join Table)
Many-to-many relationship defining which tools an agent is authorized to use.
*   `agent_id` (UUID, FK)
*   `tool_id` (UUID, FK)

### `tasks`
Represents Level 2 orchestration nodes.
*   `id` (UUID, PK)
*   `name` (String, unique)
*   `description` (Text)
*   `workflow_definition` (JSONB) - The DAG or sequential array of sub-agents/steps. *Example: `[{step: 1, agentId: "uuid-1"}, {step: 2, agentId: "uuid-2"}]`*

### `schedules` (Task Groups)
Represents Level 3 root trigger nodes.
*   `id` (UUID, PK)
*   `name` (String)
*   `trigger_type` (Enum: `cron`, `interval`, `webhook`, `manual`)
*   `trigger_config` (JSONB) - e.g., `{ "expression": "0 9 * * *" }`
*   `is_enabled` (Boolean)

### `schedule_tasks` (Join Table)
Defines the sequential array of Tasks that a Schedule executes.
*   `schedule_id` (UUID, FK)
*   `task_id` (UUID, FK)
*   `execution_order` (Int)

---

## 2. Execution Logging (Run History)

To support Page 5 (Run History) and distributed queued execution, we use an Append-only logging structure. Because the execution is fractal, our logging must also support recursion via a `parent_run_id`.

### `execution_runs`
This table records *every* time a node calls `.execute()`, regardless of whether it's an Agent, a Task, or a Schedule.
*   `id` (UUID, PK)
*   `node_type` (Enum: `agent`, `task`, `schedule`)
*   `node_id` (UUID) - Polymorphic link to either `agents.id`, `tasks.id`, or `schedules.id`.
*   `parent_run_id` (UUID, Nullable, FK to `execution_runs.id`) - Allows us to reconstruct the execution tree. A Schedule run has no parent. A Task run has the Schedule run as its parent. An Agent run has the Task run as its parent.
*   `status` (Enum: `pending`, `running`, `completed`, `failed`)
*   `input_data` (JSONB) - The payload passed *into* this node.
*   `output_data` (JSONB) - The payload generated *by* this node.
*   `started_at` (Timestamp)
*   `ended_at` (Timestamp)
*   `metrics` (JSONB) - Token usage, latency, error traces.

## 3. Database Optimizer: Performance & Indexing Strategy

To ensure Page 5 (Run History) and the worker queues do not degrade performance, we must implement specific indexing strategies to prevent Sequential Scans on our massive `execution_runs` table.

### B-Tree Indexes for Foreign Keys (Preventing N+1 & Slow Joins)
*   `CREATE INDEX idx_agent_tools_agent_id ON agent_tools(agent_id);`
*   `CREATE INDEX idx_schedule_tasks_schedule_id ON schedule_tasks(schedule_id);`
*   `CREATE INDEX idx_agents_llm_provider ON agents(llm_provider_id);`

### Hierarchical Tree Traversal Index
To quickly reconstruct the fractal Execution Tree for the UI:
*   `CREATE INDEX idx_exec_runs_parent ON execution_runs(parent_run_id);`

### Partial Indexes for Queue & Status checks
Workers will frequently poll/check for running or pending jobs. A partial index ensures this query is lightning fast by only tracking incomplete jobs:
*   `CREATE INDEX idx_exec_runs_pending ON execution_runs(status) WHERE status IN ('pending', 'running');`

### JSONB GIN Indexing
If we need to search through output data or tool payloads (e.g., "Find all runs where web search failed"):
*   `CREATE INDEX idx_exec_runs_output_gin ON execution_runs USING GIN (output_data);`

---

## 4. Global Settings

### `llm_settings`
Global configurations for external AI providers.
*   `id` (UUID, PK)
*   `provider` (Enum: `openai`, `anthropic`, `ollama`, `custom`)
*   `api_key` (String, Encrypted)
*   `base_url` (String, Nullable)
*   `parameters` (JSONB) - Defaults for temperature, top_p, etc.
*   `is_default` (Boolean)

---

## Why this design?
1.  **Polymorphic Runtime Logging (`execution_runs`)**: By storing all runs in one table with a `parent_run_id`, the UI can effortlessly render the nested progress bars and logs seen on Page 5 (Run History). The Tree of Workflows is directly mapped to a Tree of Logs.
2.  **JSONB for Flexibility**: Tool schemas, workflow DAGs, and arbitrary input/output data payloads are stored as JSONB to prevent the relational schema from becoming overly brittle.
3.  **Encrypted Configurations**: Credentials for both Tools and LLM settings are isolated in specific columns so they can be securely encrypted at rest.
