// ─── Execution Engine Types ──────────────────────────────────────────────────

export interface WorkflowStep {
  id: string;                    // REQUIRED: unique step identifier
  agentId: string;
  stepName: string;
  inputTemplate: string;         // REQUIRED: fully executable prompt with {{input}} and {{stepId}} placeholders
  dependsOn: string[];           // Array of step IDs this step depends on (empty = root step)
}

export interface ExecutionContext {
  /** The data payload passed into this node */
  inputData: Record<string, unknown>;
  /** Current recursion depth (starts at 0) */
  currentDepth: number;
  /** Total steps in the parent task */
  totalSteps: number;
  /** Hard circuit-breaker ceiling — never exceed this depth */
  maxDepth: number;
  /** The DB run ID of the parent execution_run row (null for root) */
  parentRunId: string | null;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
}

export type ExecutionSuccess = {
  success: true;
  output: Record<string, unknown>;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  toolsUsed?: string[];
  latencyMs?: number;
};

export type ExecutionFailure = {
  success: false;
  output?: Record<string, unknown>;
  error: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  toolsUsed?: string[];
  latencyMs?: number;
};

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

/** Every runnable node in the execution graph implements this */
export interface IExecutableNode {
  execute(context: ExecutionContext): Promise<ExecutionResult>;
}

// ─── LLM Provider Types ──────────────────────────────────────────────────────

export type LLMProviderName = 
  | 'llama-local'  // System-provided local llama
  | 'ollama'       // User-configured Ollama cloud
  | 'groq'         // Groq
  | 'gemini'       // Google Gemini
  | 'openai'       // OpenAI
  | 'anthropic'    // Anthropic Claude
  | 'custom';      // Custom OpenAI-compatible endpoint

export interface LLMProviderConfig {
  provider: LLMProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderRequirements {
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  defaultBaseUrl?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
}

// ─── Database Row Types ──────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  /** The system prompt / skill markdown text */
  skill: string;
  llm_provider_id: string;
  model_name: string;
  created_at: string;
  updated_at: string;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  /** JSON Schema describing the tool's parameters */
  schema: Record<string, unknown>;
  /** Encrypted key-value config (API tokens etc.) */
  config: Record<string, unknown>;
  is_enabled: boolean;
  created_at: string;
}

export interface AgentTool {
  agent_id: string;
  tool_id: string;
}

export interface Task {
  id: string;
  name: string;
  description: string;
  /** Ordered list of workflow steps - each step calls an agent with a predefined instruction */
  workflow_definition: WorkflowStep[];
  created_at: string;
  updated_at: string;
}

export interface Schedule {
  id: string;
  name: string;
  trigger_type: 'cron' | 'interval' | 'one_time' | 'webhook' | 'manual';
  trigger_config: Record<string, unknown>;
  is_enabled: boolean;
  created_at: string;
}

export interface LlmSetting {
  id: string;
  provider: LLMProviderName;
  api_key: string;
  base_url: string | null;
  model_name: string;
  is_default: boolean;
  extra_params: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type ExecutionRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ExecutionNodeType = 'agent' | 'task' | 'schedule';

export interface ExecutionRun {
  id: string;
  node_type: ExecutionNodeType;
  node_id: string;
  parent_run_id: string | null;
  status: ExecutionRunStatus;
  input_data: Record<string, unknown>;
  output_data: Record<string, unknown> | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}
