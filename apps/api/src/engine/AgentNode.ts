/**
 * AgentNode — Level 1 of the execution hierarchy
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements IExecutableNode. Fetches its config from the DB at runtime,
 * builds the message chain, delegates to the LLM factory, and writes
 * the execution_runs row (idempotent resume check included).
 *
 * Agentic loop:
 *   1. Build system prompt from agent.skill
 *   2. Start conversation with inputData as user message
 *   3. If LLM returns tool_use → execute tool → append result → loop
 *   4. When stop_reason = end_turn → parse output → mark run completed
 */

import { v4 as uuidv4 } from 'uuid';
import type { IExecutableNode, ExecutionContext, ExecutionResult, ToolDefinition } from '../types.js';
import pool from '../db/client.js';
import { LLMProviderFactory, type ChatMessage } from './LLMProviderFactory.js';
import { ToolRegistry } from './ToolRegistry.js';

const MAX_AGENT_LOOPS = 10;

export class AgentNode implements IExecutableNode {
  constructor(private readonly agentId: string) {}

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const startedAt = Date.now();

    // ── Circuit breaker ──────────────────────────────────────────────────────
    if (context.currentDepth >= context.maxDepth) {
      return {
        success: false,
        output: {},
        error: `Max depth (${context.maxDepth}) exceeded at AgentNode ${this.agentId}`,
      };
    }

    // ── Idempotent resume: skip if already completed ─────────────────────────
    if (context.parentRunId) {
      const { rows } = await pool.query<{ id: string; status: string; output_data: Record<string, unknown> }>(
        `SELECT id, status, output_data FROM execution_runs
         WHERE node_type = 'agent' AND node_id = $1
           AND parent_run_id = $2 AND status = 'completed'
         LIMIT 1`,
        [this.agentId, context.parentRunId]
      );
      if (rows.length > 0) {
        return { success: true, output: rows[0].output_data ?? {} };
      }
    }

    // ── Create execution_runs row ────────────────────────────────────────────
    const runId = uuidv4();
    await pool.query(
      `INSERT INTO execution_runs (id, node_type, node_id, parent_run_id, status, input_data, started_at)
       VALUES ($1, 'agent', $2, $3, 'running', $4, NOW())`,
      [runId, this.agentId, context.parentRunId, JSON.stringify(context.inputData)]
    );

    try {
      // ── Fetch agent definition from DB ────────────────────────────────────
      const agentRes = await pool.query<{
        name: string; skill: string; model_name: string;
        llm_provider: string; api_key: string; base_url: string | null;
      }>(
        `SELECT a.name, a.skill, a.model_name,
                l.provider AS llm_provider, l.api_key, l.base_url
         FROM agents a
         LEFT JOIN llm_settings l ON a.llm_provider_id = l.id
         WHERE a.id = $1`,
        [this.agentId]
      );

      if (agentRes.rows.length === 0) {
        throw new Error(`Agent ${this.agentId} not found`);
      }

      const agent = agentRes.rows[0];

      // ── Fetch permitted tools ─────────────────────────────────────────────
      const toolsRes = await pool.query<{ name: string; description: string; schema: Record<string, unknown>; config: Record<string, unknown> }>(
        `SELECT t.name, t.description, t.schema, t.config
         FROM tools t
         INNER JOIN agent_tools at2 ON t.id = at2.tool_id
         WHERE at2.agent_id = $1 AND t.is_enabled = true`,
        [this.agentId]
      );

      const toolDefinitions: ToolDefinition[] = toolsRes.rows.map((r) => ({
        name: r.name,
        description: r.description,
        inputSchema: r.schema,
      }));

      // ── Build LLM provider via factory ────────────────────────────────────
      const llmProvider =
        agent.llm_provider
          ? LLMProviderFactory.create({
              provider: agent.llm_provider as 'groq' | 'anthropic' | 'openai',
              apiKey: agent.api_key,
              model: agent.model_name || undefined,
              baseUrl: agent.base_url ?? undefined,
            })
          : LLMProviderFactory.create(); // fall back to env defaults

      // ── Agentic conversation loop ─────────────────────────────────────────
      const messages: ChatMessage[] = [
        { role: 'system', content: agent.skill || 'You are a helpful AI assistant.' },
        { role: 'user',   content: JSON.stringify(context.inputData) },
      ];

      let loopCount = 0;
      const usedTools: string[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let finalContent = '';

      while (loopCount < MAX_AGENT_LOOPS) {
        loopCount++;

        const response = await llmProvider.chat(messages, toolDefinitions);
        totalInputTokens += response.inputTokens;
        totalOutputTokens += response.outputTokens;

        if (response.stopReason === 'end_turn' || response.stopReason === 'stop') {
          finalContent = response.content;
          break;
        }

        if (response.stopReason === 'tool_use' && response.toolCalls.length > 0) {
          // Append assistant message
          messages.push({ role: 'assistant', content: response.content || '' });

          // Execute each tool call
          for (const tc of response.toolCalls) {
            usedTools.push(tc.name);
            const toolResult = await ToolRegistry.execute(tc.name, tc.arguments, toolsRes.rows.find(r => r.name === tc.name)?.config ?? {});
            messages.push({
              role: 'user',
              content: `Tool result for ${tc.name}:\n${JSON.stringify(toolResult)}`,
            });
          }
          continue;
        }

        // Unexpected stop — treat content as final answer
        finalContent = response.content;
        break;
      }

      const latencyMs = Date.now() - startedAt;

      // ── Parse output ─────────────────────────────────────────────────────
      let parsedOutput: Record<string, unknown>;
      try {
        parsedOutput = JSON.parse(finalContent) as Record<string, unknown>;
      } catch {
        parsedOutput = { text: finalContent };
      }

      const result: ExecutionResult = {
        success: true,
        output: parsedOutput,
        tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        toolsUsed: usedTools,
        latencyMs,
      };

      await pool.query(
        `UPDATE execution_runs
         SET status = 'completed', output_data = $1, ended_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(result.output), runId]
      );

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await pool.query(
        `UPDATE execution_runs
         SET status = 'failed', error_message = $1, ended_at = NOW()
         WHERE id = $2`,
        [errMsg, runId]
      );
      return { success: false, output: {}, error: errMsg };
    }
  }
}
