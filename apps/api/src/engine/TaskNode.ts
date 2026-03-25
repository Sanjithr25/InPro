/**
 * TaskNode — Autonomous Task Delegator
 * ─────────────────────────────────────────────────────────────────────────────
 * A TaskNode acts as a "Manager Agent". It is assigned a top-level goal (task description)
 * and a team of specialized agents (`agent_ids`).
 *
 * Instead of executing steps linearly, the Task LLM decides how to solve the goal by
 * delegating sub-tasks to its assigned agents.
 *
 * The Task LLM is given dynamic tools — one for each assigned agent (e.g., `delegate_to_researcher`).
 * When it calls a delegate tool, the TaskNode:
 *   1. Spawns an AgentNode for that specific agent
 *   2. Passes the Task LLM's instructions to the agent
 *   3. Waits for the agent to finish
 *   4. Feeds the agent's output back to the Task LLM
 *
 * The loop continues until the Task LLM determines the goal is fully achieved.
 */

import db from '../db/client.js';
import { AgentNode } from './AgentNode.js';
import { LLMProviderFactory, type ChatMessage } from './LLMProviderFactory.js';
import { ExecutionContext, ExecutionResult, IExecutableNode, ToolDefinition } from '../types.js';
import { v4 as uuidv4 } from 'uuid';

export class TaskNode implements IExecutableNode {
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { taskId, initialPrompt } = ctx.inputData as {
      taskId: string;
      initialPrompt?: string;
    };

    if (ctx.currentDepth >= ctx.maxDepth) {
        return { success: false, output: { text: '' }, error: 'Max task depth exceeded' };
    }

    // ── 1. Load task definition ───────────────────────────────────────────────
    const taskRes = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    if (taskRes.rows.length === 0) {
      return { success: false, output: { text: '' }, error: `Task not found: ${taskId}` };
    }
    const task = taskRes.rows[0];

    // Load agents from workflow definition
    const rawWorkflow = task.workflow_definition;
    const workflow: any[] = Array.isArray(rawWorkflow) ? rawWorkflow : JSON.parse(rawWorkflow ?? '[]');
    const agentIds = [...new Set(workflow.map(s => s.agentId))];
    
    let agents: any[] = [];
    if (agentIds.length > 0) {
      const agentsRes = await db.query(
        `SELECT id, name, skill FROM agents WHERE id = ANY($1::uuid[])`,
        [agentIds]
      );
      agents = agentsRes.rows;
    }

    // ── 2. Create/Update parent task run ─────────────────────────────────────
    const isDryRun = ctx.inputData.dry_run === true;
    const taskRunId = (ctx.inputData.runId as string | undefined) ?? uuidv4();
    if (!isDryRun) {
        // We use ON CONFLICT DO UPDATE because the route often creates the record first
        // to respond immediately with a matching ID for the frontend to poll.
        // We'll update it with more detailed info (like agent count) here.
        await db.query(
        `INSERT INTO execution_runs
            (id, node_type, node_id, parent_run_id, status, input_data, started_at)
        VALUES ($1, 'task', $2, $3, 'running', $4, NOW())
        ON CONFLICT (id) DO UPDATE SET 
            input_data = $4,
            status = EXCLUDED.status,
            started_at = COALESCE(execution_runs.started_at, EXCLUDED.started_at)`,
        [taskRunId, taskId, ctx.parentRunId ?? null, JSON.stringify({ taskId, initialPrompt, agents: agents.length })]
        );
    }

    // ── 3. Resolve LLM provider ───────────────────────────────────────────────
    let providerOverride: Parameters<typeof LLMProviderFactory.create>[0] = {};
    const settingsRes = await db.query(
      task.llm_provider_id
        ? `SELECT * FROM llm_settings WHERE id = $1`
        : `SELECT * FROM llm_settings WHERE is_default = true LIMIT 1`,
      [task.llm_provider_id ?? undefined].filter(Boolean)
    );

    if (settingsRes.rows.length > 0) {
      const s = settingsRes.rows[0];
      providerOverride = { provider: s.provider, apiKey: s.api_key, model: s.model_name, baseUrl: s.base_url ?? undefined };
    } else {
        await db.query(`UPDATE execution_runs SET status = 'failed', error_message = 'No LLM Provider' WHERE id = $1`, [taskRunId]);
        return { success: false, output: { text: '' }, error: 'No LLM provider configured' };
    }

    const llm = LLMProviderFactory.create(providerOverride);

    // ── 4. Build Agent Delegation Tools ───────────────────────────────────────
    const dynamicTools: ToolDefinition[] = agents.map(agent => {
        // Safe tool name: lowercase, replace non-alphanumeric with underscore
        const safeName = agent.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        return {
            name: `delegate_to_${safeName}`,
            description: `Delegate a sub-task to the agent "${agent.name}". Agent skill/role: ${agent.skill.substring(0, 500)}. Use this to assign work to this agent and wait for their response. Provide clear, comprehensive instructions.`,
            inputSchema: {
                type: 'object',
                properties: {
                    instructions: {
                        type: 'string',
                        description: 'Detailed instructions, context, and the exact goal the agent needs to achieve.',
                    }
                },
                required: ['instructions']
            },
            // Store mapping on the tool definition object (not standard but convenient)
            _agentId: agent.id,
            _agentName: agent.name
        } as unknown as ToolDefinition;
    });

    const toolMap = new Map(dynamicTools.map((t: any) => [t.name, t]));

    // ── 5. Agentic Loop for Task Manager ──────────────────────────────────────
    const workflowStr = workflow.map((s, i) => 
      `Step ${i + 1}: [${agents.find(a => a.id === s.agentId)?.name || s.agentId}] ${s.stepName}\n  Instructions: ${s.description}`
    ).join('\n');

    const systemPrompt = `You are a high-level Task Manager AI.
Your Task:
Name: ${task.name}
Description/Goal: ${task.description}

Here is the explicit workflow plan requested by the user:
<workflow_plan>
${workflowStr || "No specific workflow plan provided. Create your own."}
</workflow_plan>

You have a team of highly capable specialized agents available as tools.
Your job is to coordinate them, delegate work to them, and synthesize their outputs to achieve the overall goal.

Rules:
1. You should generally follow the <workflow_plan> provided above, but you are autonomous. You may deviate from it, repeat steps, or ask agents to correct their work if necessary.
2. Call the delegation tools to assign work to the appropriate agents. Provide clear instructions for what you need them to do.
3. Wait for the agent's response, evaluate it, and take the next step.
4. If an agent fails or provides incomplete work, explicitly tell them what to fix in a new delegation.
5. Once you determine the overall goal is fully achieved, provide a final comprehensive summary/report of the outcome to the user, and end your turn.
6. Do NOT try to do the hard work yourself if an agent is better suited for it. You are the manager.`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: initialPrompt ? `User Request: ${initialPrompt}` : "Begin executing the task." }
    ];

    const MAX_TURNS = 15;
    const allToolsUsed: string[] = [];
    const executionHistory: Set<string> = new Set();
    const totalTokens = { inputTokens: 0, outputTokens: 0 };
    let finalOutput = '';

    console.log(`[TaskNode] Starting autonomous task "${task.name}" with ${agents.length} agents squad`);

    try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
            // Check for kill signal before each LLM call
            if (ctx.abortSignal?.aborted) {
                console.log(`[TaskNode] Task "${task.name}" was killed at turn ${turn}.`);
                finalOutput += '\n\n[Task was killed by user]';
                break;
            }

            const response = await llm.chat(messages, dynamicTools, { maxTokens: 4096 });
            
            if (response.inputTokens) {
                totalTokens.inputTokens += response.inputTokens;
                totalTokens.outputTokens += response.outputTokens;
            }

            messages.push({
                role: 'assistant',
                content: response.content || '',
                // Omitting toolCalls from the history for now
                // to avoid strict validation errors in OpenAI/Groq payloads
            } as ChatMessage);

            if (response.content) {
                finalOutput += (finalOutput ? '\n\n' : '') + response.content;
            }

            if (response.stopReason !== 'tool_use' || !response.toolCalls || response.toolCalls.length === 0) {
                console.log(`[TaskNode] Task "${task.name}" finished autonomously.`);
                break;
            }

            // Execute delegated agents
            const toolResultsMsgs: ChatMessage[] = [];
            
            for (const tc of response.toolCalls) {
                if (ctx.abortSignal?.aborted) break; // React immediately to kills
                allToolsUsed.push(tc.name);
                console.log(`[TaskNode] Delegating: ${tc.name}`);
                
                const toolDef = toolMap.get(tc.name) as any;
                let toolOutput: any;

                const callFingerprint = `${tc.name}:${JSON.stringify(tc.arguments)}`;
                
                if (!toolDef || !toolDef._agentId) {
                    toolOutput = { error: `Agent tool ${tc.name} not found or invalid.` };
                } else if (executionHistory.has(callFingerprint)) {
                    // 🚨 Loop detected
                    console.log(`[TaskNode] ⚠️ Caught loop for ${tc.name}`);
                    toolOutput = { 
                        error: `[SYSTEM ALERT] You already called ${tc.name} with these exact arguments and received a response. Repeating the same action causes an infinite loop. You MUST adjust your instructions, select a different agent, or finalize the task.` 
                    };
                } else {
                    executionHistory.add(callFingerprint);
                    // Create child agent run
                    const instructions = tc.arguments.instructions as string;
                    
                    const agentRunId = uuidv4();
                    // Only persist to DB when NOT a dry run
                    if (!isDryRun) {
                        await db.query(
                            `INSERT INTO execution_runs
                                (id, node_type, node_id, parent_run_id, status, input_data, started_at)
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
                    const result = await agentNode.execute(agentCtx);

                    if (result.tokenUsage) {
                        totalTokens.inputTokens += result.tokenUsage.inputTokens;
                        totalTokens.outputTokens += result.tokenUsage.outputTokens;
                    }

                    // Update child run record (skip in dry run)
                    if (!isDryRun) {
                        await db.query(
                            `UPDATE execution_runs
                            SET status = $1, ended_at = NOW(), output_data = $2, error_message = $3
                            WHERE id = $4`,
                            [result.success ? 'completed' : 'failed', JSON.stringify(result), result.error ?? null, agentRunId]
                        );
                    }

                    toolOutput = result.success ? result.output?.text : { error: result.error };
                }

                toolResultsMsgs.push({
                    role: 'user',
                    content: `Result from ${tc.name}:\n\n${typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2)}`
                });
            }

            messages.push(...toolResultsMsgs);
            
            // Brief 1s delay to prevent hammering external APIs too aggressively
            if (turn < MAX_TURNS - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // ── 6. Update task run record ─────────────────────────────────────────────
        const outputPayload = {
            text: finalOutput,
            steps: allToolsUsed.length,
            summary: finalOutput.substring(0, 1000)
        };

        if (!isDryRun) {
            await db.query(
                `UPDATE execution_runs
                SET status = 'completed', ended_at = NOW(), output_data = $1
                WHERE id = $2`,
                [JSON.stringify(outputPayload), taskRunId]
            );
        }

        return {
            success: true,
            output: outputPayload,
            tokenUsage: totalTokens,
            toolsUsed: [...new Set(allToolsUsed)]
        };

    } catch (err: any) {
        console.error('[TaskNode Error]', err);
        if (!isDryRun) {
            await db.query(
                `UPDATE execution_runs SET status = 'failed', ended_at = NOW(), error_message = $1 WHERE id = $2`,
                [err.message, taskRunId]
            );
        }
        return { success: false, output: { text: '' }, error: err.message };
    }
  }
}
