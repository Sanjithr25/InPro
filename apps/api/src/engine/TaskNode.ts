/**
 * TaskNode — Linear Multi-Agent Orchestrator
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes a task by running its workflow_definition steps sequentially.
 *
 * Each step is an AgentNode execution. The output of step N is injected into
 * the prompt of step N+1 so agents can build on each other's work.
 *
 * Execution model:
 *   1. Create a parent execution_run record (node_type='task')
 *   2. For each step in workflow_definition (in order):
 *      a. Create a child execution_run (node_type='agent', parent_run_id=taskRunId)
 *      b. Run AgentNode with the step's agentId + composed prompt
 *      c. If step fails → mark task failed, stop chain
 *      d. Append step output to context for next step
 *   3. Mark task run completed with full chain output
 *
 * The context passed between steps:
 *   { previousOutput, stepName, stepIndex, totalSteps, taskDescription }
 */

import db from '../db/client.js';
import { AgentNode } from './AgentNode.js';
import { ExecutionContext, ExecutionResult, IExecutableNode } from '../types.js';
import { v4 as uuidv4 } from 'uuid';

export interface WorkflowStep {
  agentId: string;
  stepName: string;
  description: string;
  /** Optional override prompt for this step. If absent, the task generates one. */
  promptOverride?: string;
}

export class TaskNode implements IExecutableNode {
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { taskId, initialPrompt } = ctx.inputData as {
      taskId: string;
      initialPrompt?: string;
    };

    // ── 1. Load task definition ───────────────────────────────────────────────
    const taskRes = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    if (taskRes.rows.length === 0) {
      return { success: false, output: { text: '' }, error: `Task not found: ${taskId}` };
    }
    const task = taskRes.rows[0];
    const steps: WorkflowStep[] = Array.isArray(task.workflow_definition)
      ? task.workflow_definition
      : JSON.parse(task.workflow_definition ?? '[]');

    if (steps.length === 0) {
      return {
        success: false,
        output: { text: '' },
        error: 'Task has no workflow steps. Add at least one agent step.',
      };
    }

    // ── 2. Create parent task run ─────────────────────────────────────────────
    const taskRunId = uuidv4();
    await db.query(
      `INSERT INTO execution_runs
         (id, node_type, node_id, parent_run_id, status, input_data, started_at)
       VALUES ($1, 'task', $2, $3, 'running', $4, NOW())`,
      [
        taskRunId,
        taskId,
        ctx.parentRunId ?? null,
        JSON.stringify({ taskId, initialPrompt, steps: steps.length }),
      ]
    );

    // ── 3. Execute steps linearly ─────────────────────────────────────────────
    const stepOutputs: string[] = [];
    const allToolsUsed: string[] = [];
    const totalTokens = { inputTokens: 0, outputTokens: 0 };

    let previousOutput = initialPrompt ?? task.description ?? '';

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNumber = i + 1;

      // Build the prompt for this step — inject previous step output as context
      const stepPrompt = step.promptOverride
        ?? buildStepPrompt({
            step,
            stepIndex: i,
            totalSteps: steps.length,
            taskDescription: task.description ?? '',
            previousOutput,
            initialPrompt: initialPrompt ?? '',
          });

      console.log(
        `[TaskNode] Task "${task.name}" — Step ${stepNumber}/${steps.length}: "${step.stepName}" (agent: ${step.agentId})`
      );

      // Create child agent run
      const agentRunId = uuidv4();
      await db.query(
        `INSERT INTO execution_runs
           (id, node_type, node_id, parent_run_id, status, input_data, started_at)
         VALUES ($1, 'agent', $2, $3, 'running', $4, NOW())`,
        [
          agentRunId,
          step.agentId,
          taskRunId,
          JSON.stringify({ stepName: step.stepName, stepIndex: i, prompt: stepPrompt }),
        ]
      );

      // Run the agent
      const agentCtx: ExecutionContext = {
        inputData: {
          agentId: step.agentId,
          runId: agentRunId,
          prompt: stepPrompt,
        },
        currentDepth: ctx.currentDepth + 1,
        totalSteps: steps.length,
        maxDepth: ctx.maxDepth,
        parentRunId: taskRunId,
      };

      const agentNode = new AgentNode();
      const result = await agentNode.execute(agentCtx);

      // Update child run record
      await db.query(
        `UPDATE execution_runs
         SET status = $1, ended_at = NOW(), output_data = $2, error_message = $3
         WHERE id = $4`,
        [
          result.success ? 'completed' : 'failed',
          JSON.stringify(result),
          result.error ?? null,
          agentRunId,
        ]
      );

      if (!result.success) {
        // Chain broken — fail the task
        await db.query(
          `UPDATE execution_runs
           SET status = 'failed', ended_at = NOW(), error_message = $1
           WHERE id = $2`,
          [`Step ${stepNumber} "${step.stepName}" failed: ${result.error}`, taskRunId]
        );
        return {
          success: false,
          output: {
            text: stepOutputs.join('\n\n---\n\n'),
            failedStep: stepNumber,
            failedStepName: step.stepName,
            completedSteps: i,
          },
          error: `Step ${stepNumber} "${step.stepName}" failed: ${result.error}`,
          tokenUsage: totalTokens,
          toolsUsed: allToolsUsed,
        };
      }

      // Collect outputs
      const stepText = (result.output?.text as string) ?? '';
      stepOutputs.push(`### Step ${stepNumber}: ${step.stepName}\n\n${stepText}`);
      previousOutput = stepText;

      if (result.tokenUsage) {
        totalTokens.inputTokens  += result.tokenUsage.inputTokens;
        totalTokens.outputTokens += result.tokenUsage.outputTokens;
      }
      if (result.toolsUsed) allToolsUsed.push(...result.toolsUsed);
    }

    // ── 4. Mark task completed ────────────────────────────────────────────────
    const finalOutput = {
      text: stepOutputs.join('\n\n---\n\n'),
      steps: stepOutputs.length,
      summary: stepOutputs[stepOutputs.length - 1] ?? '',
    };

    await db.query(
      `UPDATE execution_runs
       SET status = 'completed', ended_at = NOW(), output_data = $1
       WHERE id = $2`,
      [JSON.stringify(finalOutput), taskRunId]
    );

    return {
      success: true,
      output: finalOutput,
      tokenUsage: totalTokens,
      toolsUsed: [...new Set(allToolsUsed)],
    };
  }
}

// ─── Step Prompt Builder ───────────────────────────────────────────────────────

function buildStepPrompt(opts: {
  step: WorkflowStep;
  stepIndex: number;
  totalSteps: number;
  taskDescription: string;
  previousOutput: string;
  initialPrompt: string;
}): string {
  const { step, stepIndex, totalSteps, taskDescription, previousOutput, initialPrompt } = opts;
  const isFirst = stepIndex === 0;

  if (isFirst) {
    return [
      `You are executing Step 1 of ${totalSteps} in a multi-agent workflow.`,
      `Task: ${taskDescription}`,
      `Your role in this step: ${step.description}`,
      initialPrompt ? `\nUser request:\n${initialPrompt}` : '',
    ].filter(Boolean).join('\n');
  }

  return [
    `You are executing Step ${stepIndex + 1} of ${totalSteps} in a multi-agent workflow.`,
    `Task: ${taskDescription}`,
    `Your role in this step: ${step.description}`,
    `\nOutput from the previous step:\n${previousOutput}`,
    `\nBuild upon the above to complete your step. Be specific and actionable.`,
  ].join('\n');
}
