/**
 * TaskNode — Agentic Task Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes a task by acting as a high-level "Manager" AI that coordinates
 * other agents.
 *
 * Current implementation uses a manager-agent loop that can delegate
 * to individual agent nodes based on the workflow definition.
 */

import db from '../db/client.js';
import { AgentNode } from './AgentNode.js';
import { LLMProviderFactory, type ChatMessage } from './LLMProviderFactory.js';
import { ExecutionContext, ExecutionResult, IExecutableNode, ToolDefinition } from '../types.js';
import { v4 as uuidv4 } from 'uuid';

const MAX_TURNS = 20;

export class TaskNode implements IExecutableNode {
    async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
        const { taskId, initialPrompt } = ctx.inputData as {
            taskId: string;
            initialPrompt?: string;
        };

        if (ctx.currentDepth >= ctx.maxDepth) {
            return { success: false, output: { text: '' }, error: 'Max task depth exceeded' };
        }

        // ── 1. Load Task + Steps ─────────────────────────────────────────────
        const taskRes = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
        if (taskRes.rows.length === 0) {
            return { success: false, output: { text: '' }, error: `Task not found: ${taskId}` };
        }
        const task = taskRes.rows[0];

        const workflowRes = await db.query(`SELECT * FROM schedule_tasks WHERE schedule_id = $1 ORDER BY order_index`, [taskId]);
        // Note: For standalone tasks, it might just use the workflow_definition blob.
        const rawWorkflow = task.workflow_definition;
        const workflowPlan = Array.isArray(rawWorkflow) ? rawWorkflow : JSON.parse(rawWorkflow ?? '[]');

        // ── 2. Create/Sync Task Run ──────────────────────────────────────────
        const isDryRun = ctx.inputData.dry_run === true;
        const taskRunId = (ctx.inputData.runId as string | undefined) ?? uuidv4();

        if (!isDryRun) {
            await db.query(
                `INSERT INTO execution_runs (id, node_type, node_id, parent_run_id, status, input_data, started_at)
                 VALUES ($1, 'task', $2, $3, 'running', $4, NOW())
                 ON CONFLICT (id) DO UPDATE SET 
                    status = 'running',
                    started_at = COALESCE(execution_runs.started_at, EXCLUDED.started_at),
                    input_data = $4`,
                [taskRunId, taskId, ctx.parentRunId ?? null, JSON.stringify({ taskId, initialPrompt })]
            );
        }

        // ── 3. Resolve Manager LLM ───────────────────────────────────────────
        let providerOverride: Parameters<typeof LLMProviderFactory.create>[0] = {};

        if (task.llm_provider_id) {
            const settingsRes = await db.query(`SELECT * FROM llm_settings WHERE id = $1`, [task.llm_provider_id]);
            if (settingsRes.rows.length > 0) {
                const s = settingsRes.rows[0];
                providerOverride = { provider: s.provider, apiKey: s.api_key, model: s.model_name, baseUrl: s.base_url ?? undefined };
            }
        } else {
            const defaultRes = await db.query(`SELECT * FROM llm_settings WHERE is_default = true LIMIT 1`);
            if (defaultRes.rows.length > 0) {
                const s = defaultRes.rows[0];
                providerOverride = { provider: s.provider, apiKey: s.api_key, model: s.model_name, baseUrl: s.base_url ?? undefined };
            }
        }

        const llm = LLMProviderFactory.create(providerOverride);

        // ── 4. Virtual "Agents" as Tools ─────────────────────────────────────
        // The manager can "call" an agent as if it were a tool.
        const agentsRes = await db.query(`SELECT id, name, skill FROM agents`);
        const allAgents = agentsRes.rows;

        const agentTools: ToolDefinition[] & { _agentId?: string }[] = allAgents.map(a => ({
            name: `delegate_to_${a.name.toLowerCase().replace(/\s+/g, '_')}`,
            description: `Delegate a sub-task to the ${a.name} agent. Skill: ${a.skill}. Use this for ${a.name} related tasks.`,
            inputSchema: {
                type: 'object',
                properties: { instructions: { type: 'string', description: 'Specific instructions for this agent.' } },
                required: ['instructions']
            },
            _agentId: a.id
        }));

        // ── 5. Manager Loop ──────────────────────────────────────────────────
        const workflowJson = JSON.stringify(workflowPlan, null, 2);
        const systemPrompt = `You are a high-level Task Manager AI. 
The user has a task: "${task.name}".
Description: ${task.description}

You have a proposed workflow plan:
${workflowJson}

You have access to several specialized agents. Your goal is to achieve the task by delegating to these agents in a logical sequence.
When you delegate, the agent will perform its own autonomous loop and return the result to you.
Synthesis the information you receive and decide if the task is complete or if further steps are needed.

CRITICAL: 
1. Use the "delegate_to_..." tools to start sub-tasks.
2. When you have achieved the goal, provide a final "REPORT" to the user and end your turn.
3. If an agent fails, you can try another agent or ask for clarification.`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: initialPrompt || "Execute the task based on the workflow plan." },
        ];

        let finalOutput = '';
        const allToolsUsed: string[] = [];
        const totalTokens = { inputTokens: 0, outputTokens: 0 };
        let turn = 0;

        try {
            while (turn < MAX_TURNS) {
                turn++;
                
                // Check for abort before each turn
                if (ctx.abortSignal?.aborted) {
                    throw new Error('Task execution aborted');
                }

                const response = await llm.chat(messages, agentTools, { maxTokens: 4096 });
                if (response.inputTokens) {
                    totalTokens.inputTokens += response.inputTokens;
                    totalTokens.outputTokens += response.outputTokens;
                }

                if (response.content) {
                    finalOutput += (finalOutput ? '\n\n' : '') + response.content;
                }

                if (response.stopReason === 'end_turn' || response.toolCalls.length === 0) {
                    break;
                }

                messages.push({ role: 'assistant', content: response.content } as ChatMessage);

                // Execute delegations
                for (const tc of response.toolCalls) {
                    // Check for abort before each tool call
                    if (ctx.abortSignal?.aborted) {
                        throw new Error('Task execution aborted');
                    }
                    
                    const toolDef = agentTools.find(t => t.name === tc.name) as (ToolDefinition & { _agentId?: string }) | undefined;
                    if (!toolDef || !toolDef._agentId) {
                        messages.push({ role: 'user', content: `Error: Tool "${tc.name}" not found.` });
                        continue;
                    }

                    const instructions = (tc.arguments as any).instructions || '';
                    console.log(`[TaskNode] Delegating to agent ${toolDef._agentId}: ${instructions.slice(0, 50)}...`);

                    const agentRunId = uuidv4();
                    if (!isDryRun) {
                        await db.query(
                            `INSERT INTO execution_runs (id, node_type, node_id, parent_run_id, status, input_data, started_at)
                             VALUES ($1, 'agent', $2, $3, 'running', $4, NOW())`,
                            [agentRunId, toolDef._agentId, taskRunId, JSON.stringify({ prompt: instructions })]
                        );
                    }

                    const agentCtx: ExecutionContext = {
                        inputData: { 
                            agentId: toolDef._agentId, 
                            runId: isDryRun ? undefined : agentRunId, 
                            prompt: instructions,
                            dry_run: isDryRun 
                        },
                        currentDepth: ctx.currentDepth + 1,
                        totalSteps: 1,
                        maxDepth: ctx.maxDepth,
                        parentRunId: taskRunId,
                        abortSignal: ctx.abortSignal,
                    };

                    const agentNode = new AgentNode();
                    const subResult = await agentNode.execute(agentCtx);
                    
                    if (subResult.tokenUsage) {
                        totalTokens.inputTokens += subResult.tokenUsage.inputTokens;
                        totalTokens.outputTokens += subResult.tokenUsage.outputTokens;
                    }
                    if (subResult.toolsUsed) allToolsUsed.push(...subResult.toolsUsed);

                    messages.push({
                        role: 'user',
                        content: `Agent "${tc.name}" result:\n${subResult.output?.text || (subResult.success ? 'Success (no output)' : 'Failed: ' + subResult.error)}`
                    });
                }
            }

            const outputPayload = {
                text: finalOutput,
                steps: allToolsUsed.length,
                summary: finalOutput.substring(0, 1000)
            };

            if (!isDryRun && !ctx.abortSignal?.aborted) {
                await db.query(`UPDATE execution_runs SET status = 'completed', ended_at = NOW(), output_data = $1 WHERE id = $2`, [JSON.stringify(outputPayload), taskRunId]);
            }

            return { success: true, output: outputPayload, tokenUsage: totalTokens, toolsUsed: [...new Set(allToolsUsed)] };

        } catch (err: any) {
            console.error('[TaskNode] Error:', err);
            
            const isAborted = ctx.abortSignal?.aborted || err.message?.includes('aborted');
            const errorMessage = isAborted ? 'Killed by user' : err.message;
            
            if (!isDryRun) {
                await db.query(
                    `UPDATE execution_runs SET status = 'failed', ended_at = NOW(), error_message = $1 WHERE id = $2`, 
                    [errorMessage, taskRunId]
                );
            }
            
            return { success: false, output: { text: finalOutput || '' }, error: errorMessage };
        }
    }
}
