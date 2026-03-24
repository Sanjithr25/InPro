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
  list: () => req<AgentRow[]>('/api/agents'),
  get:  (id: string) => req<AgentRow>(`/api/agents/${id}`),
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
export type ToolRow = { id: string; name: string; description: string; is_enabled: boolean };

export const toolsApi = {
  list: () => req<ToolRow[]>('/api/tools'),
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
};
