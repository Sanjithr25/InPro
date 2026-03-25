/**
 * /api/tasks — Task CRUD + execution
 * ─────────────────────────────────────────────────────────────────────────────
 * GET    /api/tasks                      — list all tasks
 * GET    /api/tasks/:id                  — single task (full)
 * POST   /api/tasks                      — create task
 * PUT    /api/tasks/:id                  — update task
 * DELETE /api/tasks/:id                  — delete task
 * POST   /api/tasks/:id/run              — execute task (sync, returns full result)
 * POST   /api/tasks/generate-workflow    — LLM generates workflow steps from description + agents
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { TaskNode } from '../engine/TaskNode.js';
import { LLMProviderFactory } from '../engine/LLMProviderFactory.js';
import type { ExecutionContext } from '../types.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── WorkflowStep schema ──────────────────────────────────────────────────────
const WorkflowStepSchema = z.object({
  agentId:        z.string().uuid(),
  stepName:       z.string().min(1),
  description:    z.string().default(''),
  promptOverride: z.string().optional(),
});

const TaskSchema = z.object({
  name:                z.string().min(1).max(200),
  description:         z.string().default(''),
  workflow_definition: z.array(WorkflowStepSchema).default([]),
  llm_provider_id:     z.string().uuid().optional().nullable(),
});

// ─── GET /api/tasks ───────────────────────────────────────────────────────────
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      t.id, t.name, t.description, t.created_at,
      jsonb_array_length(t.workflow_definition) AS step_count,
      (
        SELECT er.status FROM execution_runs er
        WHERE er.node_type = 'task' AND er.node_id = t.id
        ORDER BY er.created_at DESC LIMIT 1
      ) AS last_run_status,
      (
        SELECT er.created_at FROM execution_runs er
        WHERE er.node_type = 'task' AND er.node_id = t.id
        ORDER BY er.created_at DESC LIMIT 1
      ) AS last_run_at
    FROM tasks t
    ORDER BY t.updated_at DESC
  `);
  res.json({ data: rows });
}));

// ─── GET /api/tasks/:id ───────────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, llm_provider_id, workflow_definition, created_at, updated_at FROM tasks WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json({ data: rows[0] });
}));

// ─── POST /api/tasks ──────────────────────────────────────────────────────────
router.post('/', handle(async (req, res) => {
  const parsed = TaskSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { name, description, workflow_definition, llm_provider_id } = parsed.data;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO tasks (id, name, description, workflow_definition, llm_provider_id) VALUES ($1,$2,$3,$4,$5)`,
    [id, name, description, JSON.stringify(workflow_definition), llm_provider_id ?? null]
  );
  res.status(201).json({ data: { id } });
}));

// ─── PUT /api/tasks/:id ───────────────────────────────────────────────────────
router.put('/:id', handle(async (req, res) => {
  const parsed = TaskSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) {
      sets.push(`${k} = $${i++}`);
      vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
  }
  if (sets.length === 0) { res.json({ data: { updated: false } }); return; }
  sets.push(`updated_at = NOW()`);
  vals.push(req.params.id);
  await pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json({ data: { updated: true } });
}));

// ─── DELETE /api/tasks/:id ────────────────────────────────────────────────────
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

// ─── POST /api/tasks/:id/run ──────────────────────────────────────────────────
router.post('/:id/run', handle(async (req, res) => {
  const { prompt } = z.object({ prompt: z.string().default('') }).parse(req.body);
  const ctx: ExecutionContext = {
    inputData: { taskId: req.params.id, initialPrompt: prompt },
    currentDepth: 0,
    totalSteps: 0,
    maxDepth: 10,
    parentRunId: null,
  };
  const taskNode  = new TaskNode();
  const result    = await taskNode.execute(ctx);
  res.json({ data: result });
}));

// ─── POST /api/tasks/generate-workflow ────────────────────────────────────────
// Uses the default LLM to generate workflow steps from a task description + agents.
router.post('/generate-workflow', handle(async (req, res) => {
  const { description, agentIds } = z.object({
    description: z.string().min(1),
    agentIds: z.array(z.string().uuid()).min(1),
  }).parse(req.body);

  // Load agent names
  const agentsRes = await pool.query(
    `SELECT id, name, skill FROM agents WHERE id = ANY($1::uuid[])`,
    [agentIds]
  );
  const agents = agentsRes.rows;

  // Load default LLM provider
  const settingsRes = await pool.query(
    `SELECT * FROM llm_settings WHERE is_default = true LIMIT 1`
  );
  if (settingsRes.rows.length === 0) {
    res.status(503).json({ error: 'No default LLM provider configured.' });
    return;
  }
  const s = settingsRes.rows[0];
  const llm = LLMProviderFactory.create({
    provider: s.provider,
    apiKey:   s.api_key,
    model:    s.model_name,
    baseUrl:  s.base_url ?? undefined,
  });

  const agentList = agents.map(a =>
    `- Agent: "${a.name}" (id: ${a.id})\n  Skill: ${(a.skill as string).slice(0, 120)}…`
  ).join('\n');

  const systemPrompt = `You are a workflow planner. Given a task description and a list of AI agents, 
generate a linear step-by-step workflow. Each step must be assigned to one of the provided agents.
Respond with ONLY a valid JSON array. No markdown, no explanation, just the array.

Format:
[
  {
    "agentId": "<agent id from the list>",
    "stepName": "<short step title>",
    "description": "<what this agent should do in this step, 1-2 sentences>"
  }
]`;

  const userPrompt = `Task: ${description}

Available agents:
${agentList}

Generate a workflow of ${Math.min(agents.length, 5)} steps using these agents.`;

  const response = await llm.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    [],
    { maxTokens: 1024 }
  );

  // Parse LLM output — strip markdown fences if present
  let raw = (response.content ?? '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let steps: unknown[];
  try {
    steps = JSON.parse(raw);
    if (!Array.isArray(steps)) throw new Error('Not an array');
  } catch {
    res.status(422).json({
      error: 'LLM returned invalid workflow JSON.',
      raw: response.content,
    });
    return;
  }

  // Validate + sanitize each step
  const validated = steps
    .map((s: any) => ({
      agentId:     s.agentId ?? s.agent_id ?? '',
      stepName:    s.stepName ?? s.step_name ?? s.name ?? 'Step',
      description: s.description ?? '',
    }))
    .filter(s => agentIds.includes(s.agentId));

  res.json({ data: { steps: validated } });
}));

export default router;
