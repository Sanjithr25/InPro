/**
 * Single Agent Execution Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONLY place that executes agents.
 * All routes (/run, /stream, scheduler) MUST call this.
 *
 * Guarantees:
 * 1. Validation happens BEFORE execution
 * 2. NO runtime fallbacks
 * 3. Deterministic behavior
 * 4. Structured error handling
 */

import db from '../../db/client.js';
import { v4 as uuidv4 } from 'uuid';
import { validateAgentForExecution, type ValidatedExecutionConfig } from '../validators/validateAgentForExecution.js';
import { LLMProviderFactory, type ChatMessage } from '../LLMProviderFactory.js';
import { ToolRegistry } from '../ToolRegistry.js';
import { logger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ExecuteAgentOptions {
  agentId: string;
  prompt: string;
  runId?: string;
  parentRunId?: string | null;
  isDryRun?: boolean;
  abortSignal?: AbortSignal;
  mode?: 'sync' | 'stream';
}

export interface ExecutionError {
  type: 'validation' | 'execution' | 'tool' | 'system';
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface ExecutionSuccess {
  success: true;
  runId: string;
  output: {
    text: string;
  };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  toolsUsed: string[];
  providerInfo: {
    name: string;
    model: string;
    wrapper: 'anthropic' | 'openai' | 'unknown';
    baseUrl?: string;
  };
  executionDuration: number;
}

export interface ExecutionFailure {
  success: false;
  runId?: string;
  error: ExecutionError;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_GLOBAL_STEPS = 100; // Hard limit on total steps across all turns

// ─── Main Execution Function ───────────────────────────────────────────────────

export async function executeAgent(
  options: ExecuteAgentOptions
): Promise<ExecutionResult> {
  const { agentId, prompt, isDryRun = false, abortSignal, parentRunId = null } = options;
  const startTime = Date.now();
  
  // Generate or use provided runId
  const runId = options.runId || uuidv4();

  try {
    // ── STEP 1: VALIDATE (BLOCK EARLY) ──────────────────────────────────────
    console.log(`[executeAgent] Validating agent ${agentId} for execution...`);
    const validation = await validateAgentForExecution(agentId);

    if (!validation.valid) {
      const errorMessage = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      console.error(`[executeAgent] Validation failed:`, validation.errors);

      // Create failed run record
      await db.query(
        `INSERT INTO execution_runs 
          (id, node_type, node_id, parent_run_id, is_dry_run, trigger_type, status, input_data, error_message, started_at, ended_at)
         VALUES ($1, 'agent', $2, $3, $4, $5, 'failed', $6, $7, NOW(), NOW())`,
        [runId, agentId, parentRunId, isDryRun, isDryRun ? 'dry_run' : 'manual', JSON.stringify({ prompt, agentId }), errorMessage]
      );

      return {
        success: false,
        runId,
        error: {
          type: 'validation',
          message: errorMessage,
          retryable: validation.errors.some(e => e.retryable),
          details: validation.errors,
        },
      };
    }

    const config = validation.config;
    console.log(`[executeAgent] Validation passed. Provider: ${config.provider.provider}, Model: ${config.provider.model}`);

    // ── STEP 2: CREATE RUN RECORD ───────────────────────────────────────────
    await db.query(
      `INSERT INTO execution_runs 
        (id, node_type, node_id, parent_run_id, is_dry_run, trigger_type, status, input_data, started_at)
       VALUES ($1, 'agent', $2, $3, $4, $5, 'running', $6, NOW())`,
      [runId, agentId, parentRunId, isDryRun, isDryRun ? 'dry_run' : 'manual', JSON.stringify({ prompt, agentId })]
    );

    logger.agentStart(config.agent.name, agentId, runId, parentRunId || null);

    // ── STEP 3: EXECUTE AGENT ────────────────────────────────────────────────
    const result = await executeAgentLoop(config, prompt, runId, isDryRun, abortSignal);

    // ── STEP 4: PERSIST RESULT ───────────────────────────────────────────────
    const executionDuration = Date.now() - startTime;

    if (result.success) {
      if (!abortSignal?.aborted) {
        await db.query(
          `UPDATE execution_runs
           SET status = 'completed', ended_at = NOW(), output_data = $1, error_message = NULL
           WHERE id = $2`,
          [JSON.stringify(result), runId]
        );
        logger.agentEnd(config.agent.name, agentId, runId, true, executionDuration, result.toolsUsed);
      } else {
        await db.query(
          `UPDATE execution_runs
           SET output_data = $1
           WHERE id = $2`,
          [JSON.stringify(result), runId]
        );
        logger.agentEnd(config.agent.name, agentId, runId, false, executionDuration);
      }

      return { ...result, runId, executionDuration };
    } else {
      await db.query(
        `UPDATE execution_runs
         SET status = 'failed', ended_at = NOW(), error_message = $1
         WHERE id = $2`,
        [result.error.message, runId]
      );
      logger.error('Agent execution failed', 'agent', new Error(result.error.message), {
        agentName: config.agent.name,
        agentId,
        agentRunId: runId,
      });

      return { ...result, runId };
    }
  } catch (err: any) {
    console.error(`[executeAgent] Unexpected error:`, err);
    
    await db.query(
      `UPDATE execution_runs
       SET status = 'failed', ended_at = NOW(), error_message = $1
       WHERE id = $2`,
      [err.message, runId]
    );

    return {
      success: false,
      runId,
      error: {
        type: 'system',
        message: err.message,
        retryable: false,
      },
    };
  }
}

// ─── Agent Loop Execution ──────────────────────────────────────────────────────

async function executeAgentLoop(
  config: ValidatedExecutionConfig,
  prompt: string,
  runId: string,
  isDryRun: boolean,
  abortSignal?: AbortSignal
): Promise<ExecutionSuccess | ExecutionFailure> {
  try {
    // ── 1. Initialize LLM Provider ────────────────────────────────────────────
    const llm = LLMProviderFactory.create({
      provider: config.provider.provider,
      apiKey: config.provider.apiKey,
      model: config.provider.model,
      baseUrl: config.provider.baseUrl ?? undefined,
    });

    // ── 2. Build Tool Definitions ─────────────────────────────────────────────
    const toolDefs: ToolDefinition[] = config.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.schema,
    }));

    // ── 3. Initialize Messages ────────────────────────────────────────────────
    // Inject current date for temporal context
    const currentDate = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    const systemPrompt = config.agent.skill || 'You are a helpful AI assistant.';
    const systemPromptWithDate = `Current date: ${currentDate}. Always use this as reference for time-sensitive queries.\n\n${systemPrompt}`;
    
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptWithDate },
      { role: 'user', content: prompt },
    ];

    // ── 4. Execution State ────────────────────────────────────────────────────
    let outputText = '';
    const usedTools: string[] = [];
    const executionHistory: Set<string> = new Set();
    const tokenUsage = { inputTokens: 0, outputTokens: 0 };
    let turn = 0;
    let totalSteps = 0;

    // ── 5. Timeout Handling ───────────────────────────────────────────────────
    const timeoutMs = config.agent.timeoutMs;
    const timeoutPromise = timeoutMs
      ? new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs)
        )
      : null;

    // ── 6. Agentic Loop ───────────────────────────────────────────────────────
    const executeLoop = async () => {
      while (turn < config.agent.maxTurns) {
        turn++;
        totalSteps++;

        // Global step limit enforcement
        if (totalSteps > MAX_GLOBAL_STEPS) {
          throw new Error(`Exceeded maximum global steps (${MAX_GLOBAL_STEPS})`);
        }

        // Check abort signal
        if (abortSignal?.aborted) {
          logger.agentKilled(config.agent.name, config.agent.id, runId);
          outputText += '\n\n[Agent was killed by user]';
          break;
        }

        console.log(`[executeAgent] Turn ${turn}/${config.agent.maxTurns} — calling LLM`);

        // Build LLM options
        const llmOptions: any = { maxTokens: 4096, signal: abortSignal };
        if (config.agent.temperature !== null) {
          llmOptions.temperature = config.agent.temperature;
        }

        // Call LLM
        const response = await llm.chat(messages, toolDefs, llmOptions);

        // Track tokens
        if (response.inputTokens) {
          tokenUsage.inputTokens += response.inputTokens;
          tokenUsage.outputTokens += response.outputTokens;
        }

        // Collect text
        if (response.content) {
          outputText += response.content + '\n';
        }

        // No tool calls → done
        if (response.stopReason === 'end_turn' || response.toolCalls.length === 0) {
          break;
        }

        // ── Tool Execution Round ──────────────────────────────────────────────
        messages.push({
          role: 'assistant',
          content: response.content,
        } as ChatMessage);

        for (const tc of response.toolCalls) {
          totalSteps++;
          usedTools.push(tc.name);
          console.log(`[executeAgent] Executing tool: ${tc.name}`, tc.arguments);

          let toolResult: Record<string, unknown>;

          // Loop detection
          const callFingerprint = `${tc.name}:${JSON.stringify(tc.arguments)}`;
          if (executionHistory.has(callFingerprint)) {
            console.log(`[executeAgent] ⚠️ Loop detected for tool: ${tc.name}`);
            toolResult = {
              error: 'terminal',
              message: `[SYSTEM ALERT] You already executed this exact tool with identical arguments. Repeating the same action causes an infinite loop. You MUST change your approach, use different arguments, or end your turn.`,
            };
          } else {
            executionHistory.add(callFingerprint);
            try {
              toolResult = await ToolRegistry.execute(tc.name, tc.arguments, config.agent.id, abortSignal, isDryRun);
            } catch (toolErr: any) {
              toolResult = { error: toolErr.message };
            }
          }

          // Feed result back
          messages.push({
            role: 'user',
            content: `Tool "${tc.name}" result:\n${JSON.stringify(toolResult, null, 2)}`,
          });
        }

        // Brief delay against rate limits
        if (turn < config.agent.maxTurns - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    };

    // Execute with timeout if specified
    if (timeoutPromise) {
      await Promise.race([executeLoop(), timeoutPromise]);
    } else {
      await executeLoop();
    }

    // ── 7. Return Success ─────────────────────────────────────────────────────
    return {
      success: true,
      runId,
      output: { text: outputText.trim() || '(No text response)' },
      tokenUsage,
      toolsUsed: usedTools,
      providerInfo: {
        name: config.provider.provider,
        model: config.provider.model,
        wrapper: config.provider.provider === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: config.provider.baseUrl ?? undefined,
      },
      executionDuration: 0, // Will be set by caller
    };
  } catch (err: any) {
    console.error(`[executeAgent] Loop execution error:`, err);
    return {
      success: false,
      error: {
        type: 'execution',
        message: err.message,
        retryable: false,
      },
    };
  }
}
