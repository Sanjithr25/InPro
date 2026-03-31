/**
 * Agent Execution Validator
 * ─────────────────────────────────────────────────────────────────────────────
 * Hard validation that blocks execution early if any requirement is missing.
 * NO FALLBACKS. NO SILENT FAILURES. NO RUNTIME ASSUMPTIONS.
 *
 * This is the single source of truth for "can this agent execute?"
 */

import db from '../../db/client.js';
import { SystemConfig } from '../../config/system.js';

export interface ValidationError {
  type: 'validation';
  field: string;
  message: string;
  retryable: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidatedAgent {
  id: string;
  name: string;
  skill: string;
  llmProviderId: string;
  maxTurns: number;
  timeoutMs: number | null;
  temperature: number | null;
}

export interface ValidatedProvider {
  id: string;
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string | null;
}

export interface ValidatedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  config: Record<string, unknown>;
  riskLevel: string;
}

export interface ValidatedExecutionConfig {
  agent: ValidatedAgent;
  provider: ValidatedProvider;
  tools: ValidatedTool[];
}

/**
 * Validates an agent for execution.
 * Returns structured errors if validation fails.
 * NO FALLBACKS - if something is missing, execution MUST NOT proceed.
 */
export async function validateAgentForExecution(
  agentId: string
): Promise<{ valid: true; config: ValidatedExecutionConfig } | { valid: false; errors: ValidationError[] }> {
  const errors: ValidationError[] = [];

  // ── 1. Agent Exists ────────────────────────────────────────────────────────
  const agentRes = await db.query(
    `SELECT id, name, skill, llm_provider_id, max_turns, timeout_ms, temperature 
     FROM agents WHERE id = $1`,
    [agentId]
  );

  if (agentRes.rows.length === 0) {
    errors.push({
      type: 'validation',
      field: 'agent',
      message: `Agent not found: ${agentId}`,
      retryable: false,
    });
    return { valid: false, errors };
  }

  const agentRow = agentRes.rows[0];

  // ── 2. Provider Resolution (NO FALLBACK) ───────────────────────────────────
  let providerRow: any = null;

  if (agentRow.llm_provider_id) {
    // Agent has pinned provider
    const providerRes = await db.query(
      `SELECT id, provider, api_key, model_name, base_url 
       FROM llm_settings WHERE id = $1`,
      [agentRow.llm_provider_id]
    );

    if (providerRes.rows.length === 0) {
      errors.push({
        type: 'validation',
        field: 'provider',
        message: `Agent references provider ${agentRow.llm_provider_id} but it does not exist. Update agent configuration.`,
        retryable: false,
      });
    } else {
      providerRow = providerRes.rows[0];
    }
  } else {
    // No pinned provider - check for default
    const defaultRes = await db.query(
      `SELECT id, provider, api_key, model_name, base_url 
       FROM llm_settings WHERE is_default = true LIMIT 1`
    );

    if (defaultRes.rows.length === 0) {
      errors.push({
        type: 'validation',
        field: 'provider',
        message: 'Agent has no pinned provider and no default provider is configured. Configure a default provider in LLM Settings.',
        retryable: false,
      });
    } else {
      providerRow = defaultRes.rows[0];
    }
  }

  // ── 3. Provider Validation ─────────────────────────────────────────────────
  if (providerRow) {
    if (!providerRow.provider) {
      errors.push({
        type: 'validation',
        field: 'provider.type',
        message: 'Provider type is missing',
        retryable: false,
      });
    }

    if (!providerRow.model_name) {
      errors.push({
        type: 'validation',
        field: 'provider.model',
        message: 'Provider model is missing',
        retryable: false,
      });
    }

    // Provider-specific validation
    const requiresApiKey = ['openai', 'anthropic', 'groq', 'gemini'].includes(providerRow.provider);
    if (requiresApiKey && !providerRow.api_key) {
      errors.push({
        type: 'validation',
        field: 'provider.apiKey',
        message: `Provider "${providerRow.provider}" requires an API key. Go to Settings page to add your ${providerRow.provider.toUpperCase()} API key, or change this agent to use a different provider (e.g., Ollama for local execution).`,
        retryable: false,
      });
    }

    const requiresBaseUrl = ['ollama', 'custom'].includes(providerRow.provider);
    if (requiresBaseUrl && !providerRow.base_url) {
      errors.push({
        type: 'validation',
        field: 'provider.baseUrl',
        message: `Provider "${providerRow.provider}" requires a base URL. Go to Settings page to configure the base URL (e.g., http://localhost:11434/v1 for Ollama).`,
        retryable: false,
      });
    }
  }

  // ── 4. Tools Validation ────────────────────────────────────────────────────
  const toolsRes = await db.query(
    `SELECT t.name, t.description, t.schema, t.config, t.risk_level, t.is_enabled
     FROM tools t
     JOIN agent_tools at ON t.id = at.tool_id
     WHERE at.agent_id = $1`,
    [agentId]
  );

  const enabledTools = toolsRes.rows.filter((t: any) => t.is_enabled);
  const disabledTools = toolsRes.rows.filter((t: any) => !t.is_enabled);

  if (disabledTools.length > 0) {
    errors.push({
      type: 'validation',
      field: 'tools',
      message: `Agent has ${disabledTools.length} disabled tool(s): ${disabledTools.map((t: any) => t.name).join(', ')}. Enable them or remove from agent.`,
      retryable: true,
    });
  }

  // Validate tool schemas
  for (const tool of enabledTools) {
    if (!tool.schema) {
      errors.push({
        type: 'validation',
        field: `tool.${tool.name}.schema`,
        message: `Tool "${tool.name}" has no schema defined`,
        retryable: false,
      });
    }
  }

  // ── 5. Constraints Validation ──────────────────────────────────────────────
  const maxTurns = agentRow.max_turns ?? SystemConfig.get<number>('agent.maxTurns', 15);
  const timeoutMs = agentRow.timeout_ms ?? SystemConfig.get<number | null>('agent.defaultTimeout', null);
  const temperature = agentRow.temperature ?? SystemConfig.get<number | null>('agent.defaultTemperature', null);

  if (maxTurns <= 0) {
    errors.push({
      type: 'validation',
      field: 'constraints.maxTurns',
      message: `max_turns must be positive, got: ${maxTurns}`,
      retryable: false,
    });
  }

  if (timeoutMs !== null && timeoutMs < 0) {
    errors.push({
      type: 'validation',
      field: 'constraints.timeout',
      message: `timeout_ms must be non-negative, got: ${timeoutMs}`,
      retryable: false,
    });
  }

  if (temperature !== null && (temperature < 0 || temperature > 2)) {
    errors.push({
      type: 'validation',
      field: 'constraints.temperature',
      message: `temperature must be between 0 and 2, got: ${temperature}`,
      retryable: false,
    });
  }

  // ── 6. Return Result ───────────────────────────────────────────────────────
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    config: {
      agent: {
        id: agentRow.id,
        name: agentRow.name,
        skill: agentRow.skill,
        llmProviderId: providerRow.id,
        maxTurns,
        timeoutMs,
        temperature,
      },
      provider: {
        id: providerRow.id,
        provider: providerRow.provider,
        apiKey: providerRow.api_key,
        model: providerRow.model_name,
        baseUrl: providerRow.base_url,
      },
      tools: enabledTools.map((t: any) => ({
        name: t.name,
        description: t.description ?? '',
        schema: typeof t.schema === 'string' ? JSON.parse(t.schema) : (t.schema ?? {}),
        config: typeof t.config === 'string' ? JSON.parse(t.config) : (t.config ?? {}),
        riskLevel: t.risk_level,
      })),
    },
  };
}
