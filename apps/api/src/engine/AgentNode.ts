/**
 * AgentNode — Legacy Wrapper for Execution Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a thin wrapper around executeAgent() to maintain backward compatibility
 * with the IExecutableNode interface.
 *
 * NEW CODE SHOULD CALL executeAgent() DIRECTLY.
 */

import { executeAgent } from './agent/executeAgent.js';
import { ExecutionContext, ExecutionResult, IExecutableNode } from '../types.js';

export class AgentNode implements IExecutableNode {
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { agentId, runId, prompt } = ctx.inputData;

    const result = await executeAgent({
      agentId: agentId as string,
      prompt: prompt as string,
      runId: runId as string | undefined,
      parentRunId: ctx.parentRunId,
      isDryRun: ctx.isDryRun,
      abortSignal: ctx.abortSignal,
      mode: 'sync',
    });

    // Convert to legacy ExecutionResult format
    if (result.success) {
      return {
        success: true,
        output: result.output,
        tokenUsage: result.tokenUsage,
        toolsUsed: result.toolsUsed,
        providerInfo: result.providerInfo,
      };
    } else {
      return {
        success: false,
        output: { text: '' },
        error: result.error.message,
      };
    }
  }
}
