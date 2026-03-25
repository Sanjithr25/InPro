/**
 * AgentNode — Agentic Loop Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes an agent by:
 * 1. Loading the agent definition + tools from the database
 * 2. Resolving the LLM provider via LLMProviderFactory (Ollama / OpenAI / Anthropic)
 * 3. Running a tool-use agentic loop until the model signals end_turn
 *
 * The Claude Agent SDK is NOT used here — it spawns a child process that
 * requires a real Anthropic account. Instead we drive the loop ourselves
 * using the ChatProvider interface, which works with any OAI-compatible backend.
 */

import db from '../db/client.js';
import { ToolRegistry } from './ToolRegistry.js';
import { LLMProviderFactory, type ChatMessage } from './LLMProviderFactory.js';
import { ExecutionContext, ExecutionResult, IExecutableNode, ToolDefinition } from '../types.js';

const MAX_TURNS = 15;

export class AgentNode implements IExecutableNode {
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { agentId, runId, prompt } = ctx.inputData;

    try {
      // ── 1. Fetch Agent ────────────────────────────────────────────────────
      const agentRes = await db.query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
      if (agentRes.rows.length === 0) throw new Error(`Agent not found: ${agentId}`);
      const agent = agentRes.rows[0];

      // ── 2. Fetch Tools ────────────────────────────────────────────────────
      const toolsRes = await db.query(
        `SELECT t.* FROM tools t
         JOIN agent_tools at ON t.id = at.tool_id
         WHERE at.agent_id = $1 AND t.is_enabled = true`,
        [agentId]
      );
      const toolDefs: ToolDefinition[] = toolsRes.rows.map((t: any) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: typeof t.schema === 'string' ? JSON.parse(t.schema) : (t.schema ?? {}),
      }));

      // ── 3. Resolve LLM Provider via Factory ───────────────────────────────
      // Check if agent has a pinned llm_settings row, otherwise fall back to default
      let providerOverride: Parameters<typeof LLMProviderFactory.create>[0] = {};

      if (agent.llm_provider_id) {
        const settingsRes = await db.query(
          `SELECT * FROM llm_settings WHERE id = $1`,
          [agent.llm_provider_id]
        );
        if (settingsRes.rows.length > 0) {
          const s = settingsRes.rows[0];
          providerOverride = {
            provider: s.provider,
            apiKey: s.api_key,
            model: s.model_name,
            baseUrl: s.base_url ?? undefined,
          };
        }
      } else {
        // Use the default provider from llm_settings
        const defaultRes = await db.query(
          `SELECT * FROM llm_settings WHERE is_default = true LIMIT 1`
        );
        if (defaultRes.rows.length > 0) {
          const s = defaultRes.rows[0];
          providerOverride = {
            provider: s.provider,
            apiKey: s.api_key,
            model: s.model_name,
            baseUrl: s.base_url ?? undefined,
          };
        }
      }

      const llm = LLMProviderFactory.create(providerOverride);

      // ── 4. Mark run as running ────────────────────────────────────────────
      if (runId) {
        await db.query(`UPDATE execution_runs SET status = 'running' WHERE id = $1`, [runId]);
      }

      // ── 5. Agentic Loop ───────────────────────────────────────────────────
      const messages: ChatMessage[] = [
        { role: 'system', content: agent.skill ?? 'You are a helpful AI assistant.' },
        { role: 'user',   content: prompt as string },
      ];

      let outputText = '';
      const usedTools: string[] = [];
      const executionHistory: Set<string> = new Set();
      const tokenUsage = { inputTokens: 0, outputTokens: 0 };
      let turn = 0;

      while (turn < MAX_TURNS) {
        turn++;
        console.log(`[AgentNode] Turn ${turn} — calling LLM (${providerOverride.provider ?? 'default'})`);

        const response = await llm.chat(messages, toolDefs, { maxTokens: 4096 });

        if (response.inputTokens) {
          tokenUsage.inputTokens += response.inputTokens;
          tokenUsage.outputTokens += response.outputTokens;
        }
        // Collect assistant text
        if (response.content) {
          outputText += response.content + '\n';
        }

        // No tool calls → done
        if (response.stopReason === 'end_turn' || response.toolCalls.length === 0) {
          break;
        }

        // ── Tool execution round ─────────────────────────────────────────
        // Append assistant turn with tool calls
        messages.push({
          role: 'assistant',
          content: response.content,
        } as ChatMessage);

        // Execute each tool and append results as user messages
        for (const tc of response.toolCalls) {
          usedTools.push(tc.name);
          console.log(`[AgentNode] Executing tool: ${tc.name}`, tc.arguments);
          let toolResult: Record<string, unknown>;
          
          const callFingerprint = `${tc.name}:${JSON.stringify(tc.arguments)}`;
          
          if (executionHistory.has(callFingerprint)) {
            // 🚨 Loop detected
            console.log(`[AgentNode] ⚠️ Caught loop for tool: ${tc.name}`);
            toolResult = {
                error: 'terminal',
                message: `[SYSTEM ALERT] You already executed this exact tool with identical arguments. Repeating the same action causes an infinite loop. You MUST change your approach, use different arguments, or end your turn.`
            };
          } else {
            executionHistory.add(callFingerprint);
            try {
              toolResult = await ToolRegistry.execute(tc.name, tc.arguments, agentId as string | undefined);
            } catch (toolErr: any) {
              toolResult = { error: toolErr.message };
            }
          }

          // Feed result back as a user message (simple text representation)
          messages.push({
            role: 'user',
            content: `Tool "${tc.name}" result:\n${JSON.stringify(toolResult, null, 2)}`,
          });
        }
        
        // Brief delay against rate limits
        if (turn < MAX_TURNS - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // ── 6. Persist result ─────────────────────────────────────────────────
      const finalResult: ExecutionResult = {
        success: true,
        output: { text: outputText.trim() || '(No text response)' },
        tokenUsage,
        toolsUsed: usedTools,
        providerInfo: {
          name: providerOverride.provider ?? 'default',
          model: providerOverride.model ?? 'unknown',
          wrapper: (providerOverride.provider === 'anthropic') ? 'anthropic' : 'openai',
          baseUrl: providerOverride.baseUrl,
        },
      };

      if (runId) {
        await db.query(
          `UPDATE execution_runs
           SET status = 'completed', ended_at = NOW(), output_data = $1, error_message = NULL
           WHERE id = $2`,
          [JSON.stringify(finalResult), runId]
        );
      }

      return finalResult;

    } catch (err: any) {
      console.error('[AgentNode] Error:', err);
      if (runId) {
        await db.query(
          `UPDATE execution_runs
           SET status = 'failed', ended_at = NOW(), error_message = $1
           WHERE id = $2`,
          [err.message, runId]
        );
      }
      return {
        success: false,
        output: { text: '' },
        error: err.message,
      };
    }
  }
}
