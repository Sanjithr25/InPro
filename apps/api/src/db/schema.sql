-- ============================================================
-- AI Workflow Platform — PostgreSQL Schema (Supabase)
-- Run once via: apps/api/src/db/migrate.ts
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── LLM Provider Settings ────────────────────────────────────────────────────
-- Supports: system-provided (llama local), user-configured (ollama cloud, groq, gemini, openai, anthropic, etc.)
CREATE TABLE IF NOT EXISTS llm_settings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL CHECK (provider IN ('llama-local','ollama','groq','gemini','openai','anthropic','custom')),
  api_key      TEXT NOT NULL DEFAULT '',
  base_url     TEXT,
  model_name   TEXT NOT NULL,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  extra_params JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one provider can be default at a time (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_settings_default
  ON llm_settings (is_default) WHERE is_default = true;

-- ─── Agents ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL UNIQUE,
  skill            TEXT NOT NULL DEFAULT '',    -- System prompt / .md skill text
  llm_provider_id  UUID REFERENCES llm_settings(id) ON DELETE SET NULL,
  agent_group      TEXT NOT NULL DEFAULT '',    -- Group multiple agents
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

-- ─── Tools ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tools (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  schema      JSONB NOT NULL DEFAULT '{}',   -- JSON Schema for LLM tool call
  config      JSONB NOT NULL DEFAULT '{}',   -- Encrypted k/v (API keys etc.)
  tool_group  TEXT NOT NULL DEFAULT 'General',
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Agent ↔ Tool Join ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_id  UUID NOT NULL REFERENCES tools(id)  ON DELETE CASCADE,
  PRIMARY KEY (agent_id, tool_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_tool  ON agent_tools(tool_id);

-- ─── Tasks ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL UNIQUE,
  description         TEXT NOT NULL DEFAULT '',
  -- DAG: ordered array of { agentId, stepName, description }
  workflow_definition JSONB NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Schedules ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL UNIQUE,
  trigger_type     TEXT NOT NULL CHECK (trigger_type IN ('cron','interval','one_time','webhook','manual')),
  trigger_config   JSONB NOT NULL DEFAULT '{}',
  is_enabled       BOOLEAN NOT NULL DEFAULT true,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT CHECK (last_run_status IN ('completed','failed','running')),
  next_run_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Schedule ↔ Task Join ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_tasks (
  schedule_id UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES tasks(id)     ON DELETE CASCADE,
  order_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (schedule_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_schedule_tasks_schedule ON schedule_tasks(schedule_id);

-- ─── Polymorphic Execution Logger ─────────────────────────────────────────────
-- Every agent/task/schedule run writes here.
-- parent_run_id creates the tree: schedule_run → task_run → agent_run
CREATE TABLE IF NOT EXISTS execution_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type      TEXT NOT NULL CHECK (node_type IN ('agent','task','schedule')),
  node_id        UUID NOT NULL,
  parent_run_id  UUID REFERENCES execution_runs(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','completed','failed')),
  input_data     JSONB NOT NULL DEFAULT '{}',
  output_data    JSONB,
  error_message  TEXT,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tree traversal index (Run History page groups by parent)
CREATE INDEX IF NOT EXISTS idx_exec_runs_parent
  ON execution_runs(parent_run_id);

-- Status poll index (BullMQ workers query pending/running jobs)
CREATE INDEX IF NOT EXISTS idx_exec_runs_pending
  ON execution_runs(status) WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_exec_runs_node
  ON execution_runs(node_type, node_id);

-- ─── Seed: Default LLM provider (Llama Local) ──────────────────────────────────
-- System-provided local llama model (no API key required)
INSERT INTO llm_settings (provider, model_name, is_default, base_url, api_key)
VALUES ('llama-local', 'llama3.2', true, 'http://localhost:11434/v1', 'not-required')
ON CONFLICT DO NOTHING;
