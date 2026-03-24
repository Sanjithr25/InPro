// ─── Execution Engine Types ──────────────────────────────────────────────────

export interface ExecutionContext {
  inputData: Record<string, unknown>;
  currentDepth: number;
  totalSteps: number;
  maxDepth: number;
  parentRunId: string | null;
}

export interface ExecutionResult {
  success: boolean;
  output: Record<string, unknown>;
  error?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  toolsUsed?: string[];
  latencyMs?: number;
}

export interface IExecutableNode {
  execute(context: ExecutionContext): Promise<ExecutionResult>;
}

// ─── LLM Provider Types ──────────────────────────────────────────────────────

export type LLMProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── Database Row Types ──────────────────────────────────────────────────────

export interface Agent {
  id: string; name: string; skill: string;
  llm_provider_id: string; agent_group: string;
  created_at: string; updated_at: string;
}

export interface Tool {
  id: string; name: string; description: string;
  schema: Record<string, unknown>; config: Record<string, unknown>;
  is_enabled: boolean; created_at: string;
}

export interface LlmSetting {
  id: string; provider: LLMProviderName;
  api_key: string; base_url: string | null;
  model_name: string; is_default: boolean;
  extra_params: Record<string, unknown>;
  created_at: string; updated_at: string;
}

export type ExecutionRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ExecutionNodeType = 'agent' | 'task' | 'schedule';

export interface ExecutionRun {
  id: string; node_type: ExecutionNodeType; node_id: string;
  parent_run_id: string | null; status: ExecutionRunStatus;
  input_data: Record<string, unknown>; output_data: Record<string, unknown> | null;
  error_message: string | null; started_at: string | null; ended_at: string | null;
  created_at: string;
}
