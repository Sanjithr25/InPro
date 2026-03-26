const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  const json = await res.json() as { data?: T; error?: unknown };
  if (!res.ok) throw new Error(JSON.stringify(json.error ?? 'API error'));
  return json.data as T;
}

// ─── Agents ──────────────────────────────────────────────────────────────────
export type AgentRow = {
  id: string; name: string; skill: string; agent_group: string;
  llm_provider?: string; llm_provider_id?: string; provider_model?: string;
  tools?: { id: string; name: string; description: string }[];
  created_at: string;
};

export const agentsApi = {
  list:   () => req<AgentRow[]>('/api/agents'),
  get:    (id: string) => req<AgentRow>(`/api/agents/${id}`),
  create: (body: Partial<AgentRow> & { tool_ids?: string[] }) =>
    req<{ id: string }>('/api/agents', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<AgentRow> & { tool_ids?: string[] }) =>
    req<{ updated: boolean }>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    req<{ deleted: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),
  run: (id: string, prompt: string) =>
    req<{
      success: boolean; output: Record<string, unknown>;
      tokenUsage?: { inputTokens: number; outputTokens: number };
      toolsUsed?: string[]; latencyMs?: number; error?: string;
    }>(`/api/agents/${id}/run`, { method: 'POST', body: JSON.stringify({ prompt }) }),
};

// ─── Tools ────────────────────────────────────────────────────────────────────
export type ConfigField = {
  key: string;
  value: string;
  type: 'text' | 'secret' | 'select' | 'toggle';
  options?: string[];
};

export type ToolRow = {
  id: string;
  name: string;
  description: string;
  tool_group: string;
  is_enabled: boolean;
  is_builtin?: boolean; // Virtual field added by API
  schema?: Record<string, unknown>;
  config?: Record<string, unknown>;
  created_at: string;
};

export const toolsApi = {
  list: () => req<ToolRow[]>('/api/tools'),
  get:  (id: string) => req<ToolRow>(`/api/tools/${id}`),
  create: (body: Omit<ToolRow, 'id' | 'created_at' | 'is_builtin'>) =>
    req<{ id: string }>('/api/tools', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Omit<ToolRow, 'id' | 'created_at' | 'is_builtin'>>) =>
    req<{ updated: boolean }>(`/api/tools/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    req<{ deleted: boolean }>(`/api/tools/${id}`, { method: 'DELETE' }),
  toggle: (id: string, is_enabled: boolean) =>
    req<{ updated: boolean }>(`/api/tools/${id}`, { method: 'PUT', body: JSON.stringify({ is_enabled }) }),
};

// ─── Tasks ────────────────────────────────────────────────────────────────────
export type WorkflowStep = {
  agentId: string;
  stepName: string;
  description: string;
  promptOverride?: string;
};

export type TaskRow = {
  id: string;
  name: string;
  description: string;
  llm_provider_id?: string | null;
  workflow_definition: WorkflowStep[];
  step_count?: number;
  last_run_status?: 'pending' | 'running' | 'completed' | 'failed' | null;
  last_run_at?: string | null;
  created_at: string;
  updated_at?: string;
};

export const tasksApi = {
  list: () => req<TaskRow[]>('/api/tasks'),
  get:  (id: string) => req<TaskRow>(`/api/tasks/${id}`),
  create: (body: Pick<TaskRow, 'name' | 'description' | 'workflow_definition' | 'llm_provider_id'>) =>
    req<{ id: string }>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Pick<TaskRow, 'name' | 'description' | 'workflow_definition' | 'llm_provider_id'>>) =>
    req<{ updated: boolean }>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    req<{ deleted: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  run: (id: string, prompt?: string) =>
    req<{
      success: boolean;
      output: { text: string; steps: number; summary?: string };
      tokenUsage?: { inputTokens: number; outputTokens: number };
      toolsUsed?: string[];
      error?: string;
    }>(`/api/tasks/${id}/run`, { method: 'POST', body: JSON.stringify({ prompt: prompt ?? '' }) }),
  generateWorkflow: (description: string, agentIds: string[], llmProviderId?: string | null) =>
    req<{ steps: WorkflowStep[] }>('/api/tasks/generate-workflow', {
      method: 'POST',
      body: JSON.stringify({ description, agentIds, llmProviderId }),
    }),
  dryRun: (id: string, prompt?: string) =>
    req<{ success: boolean; output: { text: string; steps: number }; error?: string }>(
      `/api/tasks/${id}/dry-run`, { method: 'POST', body: JSON.stringify({ prompt: prompt ?? '' }) }
    ),
};

// ─── Task Runs ────────────────────────────────────────────────────────────────
export type AgentRunRow = {
  id: string;
  agent_id: string;
  agent_name: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input_data: { prompt?: string };
  output_data: { text?: string; steps?: number } | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
};

export type TaskRunRow = {
  id: string;
  task_id: string;
  task_name: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input_data: { initialPrompt?: string; agents?: number };
  output_data: { text?: string; steps?: number; summary?: string } | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
  agent_runs_count?: number;
  agent_runs?: AgentRunRow[];
};

export const taskRunsApi = {
  list: () => req<TaskRunRow[]>('/api/task-runs'),
  get:  (id: string) => req<TaskRunRow>(`/api/task-runs/${id}`),
  run:  (task_id: string, prompt?: string) =>
    req<{ run_id: string | null; status: string }>(
      '/api/task-runs', { method: 'POST', body: JSON.stringify({ task_id, prompt: prompt ?? '' }) }
    ),
  kill:   (id: string) => req<{ killed: boolean }>(`/api/task-runs/${id}/kill`, { method: 'POST' }),
  delete: (id: string) => req<{ deleted: boolean }>(`/api/task-runs/${id}`, { method: 'DELETE' }),
};

// ─── LLM Settings ────────────────────────────────────────────────────────────
export type LlmSettingRow = {
  id: string; provider: string; base_url: string | null;
  model_name: string; is_default: boolean; has_key: boolean;
  extra_params: Record<string, unknown>;
};

export const llmApi = {
  list: () => req<LlmSettingRow[]>('/api/llm-settings'),
  update: (id: string, body: Partial<LlmSettingRow> & { api_key?: string }) =>
    req<{ updated: boolean }>(`/api/llm-settings/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  create: (body: { provider: string; api_key?: string; base_url?: string; model_name: string; is_default?: boolean }) =>
    req<{ id: string }>('/api/llm-settings', { method: 'POST', body: JSON.stringify(body) }),
  delete: (id: string) =>
    req<{ deleted: boolean; agentsUpdated: number; message: string }>(`/api/llm-settings/${id}`, { method: 'DELETE' }),
};

// ─── Filesystem Browser ───────────────────────────────────────────────────────
export type FsBrowseResult = {
  current: string;
  parent: string | null;
  is_root: boolean;
  children: { name: string; path: string }[];
};

export type FsHomeResult = {
  home: string;
  documents: string;
  desktop: string;
};

export const fsApi = {
  home: () => req<FsHomeResult>('/api/fs/home'),
  browse: (path: string) => req<FsBrowseResult>(`/api/fs/browse?path=${encodeURIComponent(path)}`),
};

