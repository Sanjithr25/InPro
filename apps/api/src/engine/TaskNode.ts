/**
 * TaskNode — DAG-Based Workflow Executor
 */

import db from '../db/client.js';
import { executeAgent } from './agent/executeAgent.js';
import { ExecutionContext, ExecutionResult, IExecutableNode, WorkflowStep } from '../types.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const MAX_PARALLEL = 3;

export class TaskNode implements IExecutableNode {
    async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
        const startTime = Date.now();
        const { taskId, initialPrompt } = ctx.inputData as {
            taskId: string;
            initialPrompt?: string;
        };

        if (ctx.currentDepth >= ctx.maxDepth) {
            return { success: false, output: {}, error: 'Max task depth exceeded' };
        }

        const taskRes = await db.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
        if (taskRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Task not found: ' + taskId };
        }
        const task = taskRes.rows[0];

        const rawWorkflow = task.workflow_definition;
        const workflowDefinition: WorkflowStep[] = Array.isArray(rawWorkflow) 
            ? rawWorkflow 
            : JSON.parse(rawWorkflow || '[]');

        const validationErrors = this.validateWorkflow(workflowDefinition);
        if (validationErrors.length > 0) {
            const errorMsg = 'Invalid workflow definition: ' + validationErrors.join('; ');
            console.error('[TaskNode] Validation failed:', validationErrors);
            return { success: false, output: {}, error: errorMsg };
        }

        const isDryRun = ctx.inputData.dry_run === true;
        const taskRunId = (ctx.inputData.runId as string | undefined) || uuidv4();

        if (!isDryRun) {
            await db.query(
                'INSERT INTO execution_runs (id, node_type, node_id, parent_run_id, status, input_data, started_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) ON CONFLICT (id) DO UPDATE SET status = $5, started_at = COALESCE(execution_runs.started_at, EXCLUDED.started_at), input_data = $6',
                [taskRunId, 'task', taskId, ctx.parentRunId || null, 'running', JSON.stringify({ taskId, initialPrompt })]
            );
        }

        logger.taskStart(task.name, taskId, taskRunId, ctx.parentRunId);
        console.log('[TaskNode] Starting DAG execution: ' + task.name + ' (' + taskRunId + ')');
        console.log('[TaskNode] Workflow has ' + workflowDefinition.length + ' steps');


        const initialInput = initialPrompt || task.description || '';
        const completed = new Map<string, string>();
        const totalTokens = { inputTokens: 0, outputTokens: 0 };
        const allToolsUsed: string[] = [];
        const stepOutputs: Array<{
            stepId: string;
            stepName: string;
            agentId: string;
            output: string;
            runId: string;
        }> = [];

        try {
            const stepMap = new Map<string, WorkflowStep>();
            workflowDefinition.forEach(step => stepMap.set(step.id, step));

            const dependedOn = new Set<string>();
            workflowDefinition.forEach(step => {
                step.dependsOn.forEach(depId => dependedOn.add(depId));
            });
            const terminalSteps = workflowDefinition
                .filter(step => !dependedOn.has(step.id))
                .map(step => step.id);

            console.log('[TaskNode] Terminal steps: ' + terminalSteps.join(', '));

            while (completed.size < workflowDefinition.length) {
                if (ctx.abortSignal && ctx.abortSignal.aborted) {
                    throw new Error('Task execution aborted by user');
                }

                const runnable = workflowDefinition.filter(step => 
                    !completed.has(step.id) && 
                    step.dependsOn.every(depId => completed.has(depId))
                );

                if (runnable.length === 0) {
                    const remaining = workflowDefinition.filter(step => !completed.has(step.id));
                    throw new Error(
                        'Workflow stuck: ' + remaining.length + ' steps remaining but none are runnable. Check for circular dependencies or missing step IDs.'
                    );
                }

                console.log('[TaskNode] Runnable steps: ' + runnable.map(s => s.stepName).join(', '));

                const batch = runnable.slice(0, MAX_PARALLEL);
                const results = await Promise.all(
                    batch.map(step => this.executeStep(
                        step, initialInput, completed, taskRunId, isDryRun, ctx.abortSignal
                    ))
                );

                for (let i = 0; i < batch.length; i++) {
                    const step = batch[i];
                    const result = results[i];

                    if (!result.success) {
                        if (!isDryRun) {
                            await db.query(
                                'UPDATE execution_runs SET status = $1, ended_at = NOW(), output_data = $2, error_message = $3 WHERE id = $4',
                                ['failed', JSON.stringify({ steps: stepOutputs, failedAt: step.stepName }), 'Step "' + step.stepName + '" failed: ' + result.error, taskRunId]
                            );
                        }

                        return {
                            success: false,
                            output: { steps: stepOutputs, failedAt: step.stepName },
                            error: 'Step "' + step.stepName + '" failed: ' + result.error,
                            tokenUsage: totalTokens,
                            toolsUsed: [...new Set(allToolsUsed)],
                        };
                    }

                    completed.set(step.id, result.output);
                    stepOutputs.push({
                        stepId: step.id,
                        stepName: step.stepName,
                        agentId: step.agentId,
                        output: result.output,
                        runId: result.runId,
                    });

                    if (result.tokenUsage) {
                        totalTokens.inputTokens += result.tokenUsage.inputTokens;
                        totalTokens.outputTokens += result.tokenUsage.outputTokens;
                    }
                    if (result.toolsUsed) {
                        allToolsUsed.push(...result.toolsUsed);
                    }
                }
            }

            const finalOutput: Record<string, string> = {};
            terminalSteps.forEach(stepId => {
                const output = completed.get(stepId);
                if (output) {
                    finalOutput[stepId] = output;
                }
            });

            const outputPayload = { steps: stepOutputs, finalOutput };

            if (!isDryRun && (!ctx.abortSignal || !ctx.abortSignal.aborted)) {
                await db.query(
                    'UPDATE execution_runs SET status = $1, ended_at = NOW(), output_data = $2 WHERE id = $3',
                    ['completed', JSON.stringify(outputPayload), taskRunId]
                );
            }

            console.log('[TaskNode] Task completed successfully. Total tokens: ' + (totalTokens.inputTokens + totalTokens.outputTokens));
            logger.taskEnd(task.name, taskId, taskRunId, true, Date.now() - startTime);

            return {
                success: true,
                output: outputPayload,
                tokenUsage: totalTokens,
                toolsUsed: [...new Set(allToolsUsed)],
            };

        } catch (err: any) {
            console.error('[TaskNode] Error:', err);
            
            const isAborted = (ctx.abortSignal && ctx.abortSignal.aborted) || (err.message && err.message.includes('aborted'));
            const errorMessage = isAborted ? 'Killed by user' : err.message;
            
            if (!isDryRun) {
                await db.query(
                    'UPDATE execution_runs SET status = $1, ended_at = NOW(), output_data = $2, error_message = $3 WHERE id = $4',
                    ['failed', JSON.stringify({ steps: stepOutputs }), errorMessage, taskRunId]
                );
            }

            logger.taskEnd(task.name, taskId, taskRunId, false, Date.now() - startTime, errorMessage);
            
            return {
                success: false,
                output: { steps: stepOutputs },
                error: errorMessage,
                tokenUsage: totalTokens,
                toolsUsed: [...new Set(allToolsUsed)],
            };
        }
    }


    private async executeStep(
        step: WorkflowStep,
        initialInput: string,
        completed: Map<string, string>,
        taskRunId: string,
        isDryRun: boolean,
        abortSignal?: AbortSignal
    ): Promise<{
        success: boolean;
        output: string;
        runId: string;
        error?: string;
        tokenUsage?: { inputTokens: number; outputTokens: number };
        toolsUsed?: string[];
    }> {
        console.log('[TaskNode] Executing step: ' + step.stepName + ' (' + step.id + ')');

        let resolvedPrompt = step.inputTemplate.replace(/\{\{input\}\}/g, initialInput);

        for (const [stepId, output] of completed.entries()) {
            const placeholder = new RegExp('\\{\\{' + stepId + '\\}\\}', 'g');
            resolvedPrompt = resolvedPrompt.replace(placeholder, output);
        }

        console.log('[TaskNode] Resolved prompt (first 100 chars): ' + resolvedPrompt.slice(0, 100) + '...');

        const agentRunId = uuidv4();

        const result = await executeAgent({
            agentId: step.agentId,
            prompt: resolvedPrompt,
            runId: agentRunId,
            parentRunId: taskRunId,
            isDryRun,
            abortSignal,
        });

        if (!result.success) {
            console.error('[TaskNode] Step ' + step.stepName + ' failed:', result.error);
            return {
                success: false,
                output: '',
                runId: agentRunId,
                error: typeof result.error === 'string' ? result.error : 'Unknown error',
            };
        }

        console.log('[TaskNode] Step ' + step.stepName + ' completed. Output length: ' + result.output.text.length + ' chars');

        return {
            success: true,
            output: result.output.text,
            runId: agentRunId,
            tokenUsage: result.tokenUsage,
            toolsUsed: result.toolsUsed,
        };
    }

    private validateWorkflow(workflow: WorkflowStep[]): string[] {
        const errors: string[] = [];

        if (!Array.isArray(workflow)) {
            errors.push('workflow_definition must be an array');
            return errors;
        }

        if (workflow.length === 0) {
            errors.push('workflow_definition cannot be empty');
            return errors;
        }

        const stepIds = new Set<string>();
        const duplicates = new Set<string>();

        workflow.forEach((step, index) => {
            if (!step.id || typeof step.id !== 'string' || step.id.trim() === '') {
                errors.push('Step ' + (index + 1) + ': missing or invalid id');
            } else {
                if (stepIds.has(step.id)) {
                    duplicates.add(step.id);
                }
                stepIds.add(step.id);
            }

            if (!step.agentId || typeof step.agentId !== 'string') {
                errors.push('Step ' + (index + 1) + ' (' + (step.id || 'unnamed') + '): missing or invalid agentId');
            }

            if (!step.stepName || typeof step.stepName !== 'string' || step.stepName.trim() === '') {
                errors.push('Step ' + (index + 1) + ' (' + (step.id || 'unnamed') + '): missing or invalid stepName');
            }

            if (!step.inputTemplate || typeof step.inputTemplate !== 'string' || step.inputTemplate.trim() === '') {
                errors.push('Step ' + (index + 1) + ' (' + (step.stepName || 'unnamed') + '): missing or empty inputTemplate');
            }

            if (!Array.isArray(step.dependsOn)) {
                errors.push('Step ' + (index + 1) + ' (' + (step.stepName || 'unnamed') + '): dependsOn must be an array');
            }
        });

        if (duplicates.size > 0) {
            errors.push('Duplicate step IDs found: ' + Array.from(duplicates).join(', '));
        }

        workflow.forEach((step, index) => {
            if (Array.isArray(step.dependsOn)) {
                step.dependsOn.forEach(depId => {
                    if (!stepIds.has(depId)) {
                        errors.push('Step ' + (index + 1) + ' (' + (step.stepName || 'unnamed') + '): depends on non-existent step "' + depId + '"');
                    }
                    if (depId === step.id) {
                        errors.push('Step ' + (index + 1) + ' (' + (step.stepName || 'unnamed') + '): cannot depend on itself');
                    }
                });
            }
        });

        const hasCycle = this.detectCycles(workflow);
        if (hasCycle) {
            errors.push('Circular dependency detected in workflow');
        }

        return errors;
    }

    private detectCycles(workflow: WorkflowStep[]): boolean {
        const stepMap = new Map<string, WorkflowStep>();
        workflow.forEach(step => stepMap.set(step.id, step));

        const visited = new Set<string>();
        const recStack = new Set<string>();

        const dfs = (stepId: string): boolean => {
            visited.add(stepId);
            recStack.add(stepId);

            const step = stepMap.get(stepId);
            if (step) {
                for (const depId of step.dependsOn) {
                    if (!visited.has(depId)) {
                        if (dfs(depId)) return true;
                    } else if (recStack.has(depId)) {
                        return true;
                    }
                }
            }

            recStack.delete(stepId);
            return false;
        };

        for (const step of workflow) {
            if (!visited.has(step.id)) {
                if (dfs(step.id)) return true;
            }
        }

        return false;
    }
}
