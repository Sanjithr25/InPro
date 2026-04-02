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
  onStream?: (event: StreamEvent) => void;
}

export type StreamEvent =
  | { type: 'validation'; data: { status: 'passed' | 'failed'; provider?: string; model?: string; errors?: Array<{ field: string; message: string }> } }
  | { type: 'start'; data: { agentName: string; provider: string; model: string } }
  | { type: 'turn'; data: { turn: number; maxTurns: number } }
  | { type: 'text'; data: { delta: string } }
  | { type: 'tool_start'; data: { name: string; arguments: Record<string, unknown> } }
  | { type: 'tool_result'; data: { name: string; result: Record<string, unknown>; duration: number } }
  | { type: 'done'; data: ExecutionSuccess }
  | { type: 'error'; data: { message: string; type: string } };

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
  const { agentId, prompt, isDryRun = false, abortSignal, parentRunId = null, onStream } = options;
  const startTime = Date.now();
  
  // Generate or use provided runId
  const runId = options.runId || uuidv4();

  try {
    // ── STEP 1: VALIDATE (BLOCK EARLY) ──────────────────────────────────────
    logger.agentValidation(agentId, true);
    const validation = await validateAgentForExecution(agentId);

    if (!validation.valid) {
      const errorMessage = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      logger.agentValidation(agentId, false, validation.errors);
      
      onStream?.({ type: 'validation', data: { status: 'failed', errors: validation.errors } });

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
    logger.agentValidation(agentId, true);
    
    onStream?.({ 
      type: 'validation', 
      data: { 
        status: 'passed', 
        provider: config.provider.provider, 
        model: config.provider.model 
      } 
    });

    // ── STEP 2: CREATE RUN RECORD ───────────────────────────────────────────
    await db.query(
      `INSERT INTO execution_runs 
        (id, node_type, node_id, parent_run_id, is_dry_run, trigger_type, status, input_data, started_at)
       VALUES ($1, 'agent', $2, $3, $4, $5, 'running', $6, NOW())`,
      [runId, agentId, parentRunId, isDryRun, isDryRun ? 'dry_run' : 'manual', JSON.stringify({ prompt, agentId })]
    );

    logger.agentStart(config.agent.name, agentId, runId, parentRunId || null);
    
    onStream?.({ 
      type: 'start', 
      data: { 
        agentName: config.agent.name, 
        provider: config.provider.provider, 
        model: config.provider.model 
      } 
    });

    // ── STEP 3: EXECUTE AGENT ────────────────────────────────────────────────
    const result = await executeAgentLoop(config, prompt, runId, isDryRun, abortSignal, onStream);

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

      const finalResult = { ...result, runId, executionDuration };
      onStream?.({ type: 'done', data: finalResult });
      
      if (isDryRun) {
        logger.dryRunEnd(runId, agentId, true, executionDuration);
        // Retention policy for dry runs
        const { rows } = await db.query(
          `SELECT id FROM execution_runs 
           WHERE node_id = $1 AND is_dry_run = true 
           ORDER BY created_at DESC OFFSET 3`,
          [agentId]
        );
        if (rows.length > 0) {
          const idsToDelete = rows.map(r => r.id);
          await db.query(
            `DELETE FROM execution_runs WHERE id = ANY($1)`,
            [idsToDelete]
          );
          logger.dryRunRetention(agentId, rows.length, 3);
        }
      }
      
      return finalResult;
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

      onStream?.({ type: 'error', data: { message: result.error.message, type: result.error.type } });
      
      if (isDryRun) {
        logger.dryRunEnd(runId, agentId, false, Date.now() - startTime);
      }

      return { ...result, runId };
    }
  } catch (err: any) {
    logger.error('Unexpected agent execution error', 'agent', err, { agentId, agentRunId: runId });
    
    await db.query(
      `UPDATE execution_runs
       SET status = 'failed', ended_at = NOW(), error_message = $1
       WHERE id = $2`,
      [err.message, runId]
    );

    onStream?.({ type: 'error', data: { message: err.message, type: 'system' } });

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
  abortSignal?: AbortSignal,
  onStream?: (event: StreamEvent) => void
): Promise<ExecutionSuccess | ExecutionFailure> {
  try {
    // ── 1. Initialize LLM Provider ────────────────────────────────────────────
    logger.llmInit(
      config.provider.provider, 
      config.provider.model, 
      ['anthropic', 'ollama', 'llama-local'].includes(config.provider.provider) ? 'anthropic' : 'openai',
      config.provider.baseUrl ?? undefined
    );
    
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

        logger.agentTurn(config.agent.name, runId, turn, config.agent.maxTurns);
        onStream?.({ type: 'turn', data: { turn, maxTurns: config.agent.maxTurns } });

        // Build LLM options
        const llmOptions: any = { maxTokens: 4096, signal: abortSignal };
        if (config.agent.temperature !== null) {
          llmOptions.temperature = config.agent.temperature;
        }

        // Use streaming API
        let turnText = '';
        const turnToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
        let stopReason = 'end_turn';
        let turnInputTokens = 0;
        let turnOutputTokens = 0;

        for await (const chunk of llm.chatStream(messages, toolDefs, llmOptions)) {
          if (chunk.type === 'text') {
            turnText += chunk.delta;
            outputText += chunk.delta;
            onStream?.({ type: 'text', data: { delta: chunk.delta } });
          } else if (chunk.type === 'tool_call') {
            turnToolCalls.push({ name: chunk.name, arguments: chunk.arguments });
          } else if (chunk.type === 'done') {
            stopReason = chunk.stopReason;
            turnInputTokens = chunk.inputTokens;
            turnOutputTokens = chunk.outputTokens;
          }
        }

        // Track tokens
        tokenUsage.inputTokens += turnInputTokens;
        tokenUsage.outputTokens += turnOutputTokens;

        // No tool calls → done
        if (stopReason === 'end_turn' || turnToolCalls.length === 0) {
          break;
        }

        // ── Tool Execution Round ──────────────────────────────────────────────
        messages.push({
          role: 'assistant',
          content: turnText,
        } as ChatMessage);

        for (const tc of turnToolCalls) {
          totalSteps++;
          usedTools.push(tc.name);
          
          const toolStartTime = Date.now();
          logger.agentToolExecution(config.agent.name, runId, tc.name, tc.arguments);
          onStream?.({ type: 'tool_start', data: { name: tc.name, arguments: tc.arguments } });

          let toolResult: Record<string, unknown>;

          // Loop detection
          const callFingerprint = `${tc.name}:${JSON.stringify(tc.arguments)}`;
          if (executionHistory.has(callFingerprint)) {
            logger.warn(`Loop detected for tool: ${tc.name}`, 'tool', { agentName: config.agent.name, agentRunId: runId });
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
          
          const toolDuration = Date.now() - toolStartTime;
          onStream?.({ type: 'tool_result', data: { name: tc.name, result: toolResult, duration: toolDuration } });

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
        wrapper: ['anthropic', 'ollama', 'llama-local'].includes(config.provider.provider) ? 'anthropic' : 'openai',
        baseUrl: config.provider.baseUrl ?? undefined,
      },
      executionDuration: 0, // Will be set by caller
    };
  } catch (err: any) {
    logger.error('Agent loop execution error', 'agent', err, { agentName: config.agent.name, agentRunId: runId });
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
