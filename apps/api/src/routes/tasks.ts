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
// CRITICAL: inputTemplate is REQUIRED and must be a fully executable prompt
// Supports placeholders: {{input}} (initial task input) and {{stepId}} (output from step with that ID)
const WorkflowStepSchema = z.object({
  id:            z.string().min(1),  // REQUIRED: unique step identifier
  agentId:       z.string().uuid(),
  stepName:      z.string().min(1),
  inputTemplate: z.string().min(1), // REQUIRED: fully executable prompt with placeholders
  dependsOn:     z.array(z.string()).default([]), // Array of step IDs this step depends on
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
      t.id, t.name, t.description, t.created_at, t.workflow_definition,
      jsonb_array_length(t.workflow_definition) AS step_count,
      last_runs.status AS last_run_status,
      last_runs.created_at AS last_run_at
    FROM tasks t
    LEFT JOIN LATERAL (
      SELECT er.status, er.created_at
      FROM execution_runs er
      WHERE er.node_type = 'task' AND er.node_id = t.id
      ORDER BY er.created_at DESC
      LIMIT 1
    ) last_runs ON true
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
      vals.push(v === null ? null : typeof v === 'object' ? JSON.stringify(v) : v);
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

// ─── POST /api/tasks/:id/dry-run ─────────────────────────────────────────────
// Runs the task exactly like a normal run but marks it dry_run=true so TaskNode
// skips writing to execution_runs. Good for testing workflow correctness.
router.post('/:id/dry-run', handle(async (req, res) => {
  const { prompt } = z.object({ prompt: z.string().default('') }).parse(req.body);
  const ctx: ExecutionContext = {
    inputData: { taskId: req.params.id, initialPrompt: prompt, dry_run: true },
    currentDepth: 0,
    totalSteps: 0,
    maxDepth: 10,
    parentRunId: null,
  };
  const taskNode = new TaskNode();
  const result   = await taskNode.execute(ctx);
  res.json({ data: result });
}));

// ─── POST /api/tasks/generate-workflow ────────────────────────────────────────
// Uses the specified or default LLM to generate workflow steps from a task description + agents.
router.post('/generate-workflow', handle(async (req, res) => {
  const { description, agentIds, llmProviderId } = z.object({
    description: z.string().min(1),
    agentIds: z.array(z.string().uuid()).min(1),
    llmProviderId: z.string().uuid().optional().nullable(),
  }).parse(req.body);

  // Load agent names
  const agentsRes = await pool.query(
    `SELECT id, name, skill FROM agents WHERE id = ANY($1::uuid[])`,
    [agentIds]
  );
  const agents = agentsRes.rows;

  // Load LLM provider settings (specific or default)
  let s: any;
  if (llmProviderId) {
    const res = await pool.query(`SELECT * FROM llm_settings WHERE id = $1`, [llmProviderId]);
    s = res.rows[0];
  }

  if (!s) {
    const res = await pool.query(`SELECT * FROM llm_settings WHERE is_default = true LIMIT 1`);
    s = res.rows[0];
  }

  if (!s) {
    res.status(503).json({ error: 'No LLM provider configured. Please add one in Settings.' });
    return;
  }

  const llm = LLMProviderFactory.create({
    provider: s.provider,
    apiKey:   s.api_key,
    model:    s.model_name,
    baseUrl:  s.base_url ?? undefined,
  });

  const agentList = agents.map(a =>
    `- Agent: "${a.name}" (id: ${a.id})\n  Skill: ${(a.skill as string).slice(0, 120)}…`
  ).join('\n');

  const systemPrompt = `You are a workflow planner. Given a task description and a list of AI agents, generate a DAG-based workflow. Each step must be assigned to one of the provided agents and can depend on multiple previous steps.

  CRITICAL REQUIREMENTS:
  1. Your entire response must be ONLY a valid JSON array. Do NOT include any explanation, markdown, code fences, or preamble. Start your response with [ and end with ].
  2. Each step MUST have:
     - "id": unique identifier (e.g., "step1", "step2")
     - "agentId": agent UUID from the provided list
     - "stepName": short descriptive title
     - "inputTemplate": fully executable prompt for that agent
     - "dependsOn": array of step IDs this step depends on (empty array for root steps)
  3. The inputTemplate can use these placeholders:
     - {{input}} = the initial task input/description
     - {{stepId}} = the output from step with that ID (e.g., {{step1}}, {{step2}})
  4. The inputTemplate must be specific and actionable - it will be executed directly without interpretation.
  5. You can create parallel workflows by having multiple steps with the same dependencies.
  6. Ensure no circular dependencies exist.

  Format:
  [
    {
      "id": "step1",
      "agentId": "<agent id from the list>",
      "stepName": "<short step title>",
      "inputTemplate": "<fully executable prompt with {{input}} and/or {{stepId}} placeholders>",
      "dependsOn": []
    }
  ]

  Example (linear workflow):
  [
    {
      "id": "step1",
      "agentId": "abc-123",
      "stepName": "Research Requirements",
      "inputTemplate": "Research and analyze the following requirements: {{input}}. Provide a detailed analysis of technical feasibility and constraints.",
      "dependsOn": []
    },
    {
      "id": "step2",
      "agentId": "def-456",
      "stepName": "Design Solution",
      "inputTemplate": "Based on this analysis: {{step1}}, design a technical solution that addresses all requirements. Include architecture diagrams and component specifications.",
      "dependsOn": ["step1"]
    }
  ]

  Example (parallel + merge workflow):
  [
    {
      "id": "step1",
      "agentId": "abc-123",
      "stepName": "Research Market",
      "inputTemplate": "Research market trends for: {{input}}",
      "dependsOn": []
    },
    {
      "id": "step2",
      "agentId": "def-456",
      "stepName": "Research Competitors",
      "inputTemplate": "Research competitors for: {{input}}",
      "dependsOn": []
    },
    {
      "id": "step3",
      "agentId": "ghi-789",
      "stepName": "Synthesize Report",
      "inputTemplate": "Create a comprehensive report combining market analysis: {{step1}} and competitor analysis: {{step2}}",
      "dependsOn": ["step1", "step2"]
    }
  ]`;

  const userPrompt = `Task: ${description}

  Available agents:
  ${agentList}

  Generate a workflow of ${Math.min(agents.length, 5)} steps using these agents. Each step must have:
  - A unique "id" field (e.g., "step1", "step2")
  - A specific "inputTemplate" that will be executed directly
  - A "dependsOn" array listing step IDs it depends on (empty for root steps)
  
  Consider if any steps can run in parallel (same dependencies) or if the workflow should be linear.`;

  // Inject current date for temporal context
  const currentDate = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const systemPromptWithDate = `Current date: ${currentDate}. Always use this as reference for time-sensitive queries.\n\n${systemPrompt}`;

  const response = await llm.chat(
    [
      { role: 'system', content: systemPromptWithDate },
      { role: 'user',   content: userPrompt },
    ],
    [],
    { maxTokens: 8192 }
  );

  // Parse LLM output — robustly extract JSON array from response
  const rawFull = (response.content ?? '').trim();
  console.log('[tasks/generate-workflow] Raw LLM response:', rawFull.slice(0, 500));

  // Strategy 1: strip markdown fences (handle multiline fences too)
  let raw = rawFull.replace(/^```(?:json)?[\s\S]*?\n/i, '').replace(/\n?```\s*$/i, '').trim();

  // Strategy 2: if still not valid, try extracting first [...] block
  let steps: unknown[];
  try {
    steps = JSON.parse(raw);
    if (!Array.isArray(steps)) throw new Error('Not an array');
  } catch {
    // Fallback: find first JSON array in the string
    const arrMatch = rawFull.match(/\[[\s\S]*?\]/);
    if (arrMatch) {
      try {
        steps = JSON.parse(arrMatch[0]);
        if (!Array.isArray(steps)) throw new Error('Not an array');
      } catch {
        console.error('[tasks/generate-workflow] Failed to parse LLM JSON. Raw:', rawFull);
        res.status(422).json({
          error: 'LLM returned invalid workflow JSON.',
          hint: 'The LLM did not respond with a valid JSON array. Try again or switch to a more capable model.',
          raw: rawFull,
        });
        return;
      }
    } else {
      console.error('[tasks/generate-workflow] No JSON array found in LLM response. Raw:', rawFull);
      res.status(422).json({
        error: 'LLM returned invalid workflow JSON.',
        hint: 'No JSON array found in the response. Try again or switch to a more capable model.',
        raw: rawFull,
      });
      return;
    }
  }

  // Validate + sanitize each step
  const validated = steps
    .map((s: any) => ({
      id:            s.id ?? '',
      agentId:       s.agentId ?? s.agent_id ?? '',
      stepName:      s.stepName ?? s.step_name ?? s.name ?? 'Step',
      inputTemplate: s.inputTemplate ?? s.input_template ?? s.prompt ?? '',
      dependsOn:     Array.isArray(s.dependsOn) ? s.dependsOn : (Array.isArray(s.depends_on) ? s.depends_on : []),
    }))
    .filter(s => s.id && agentIds.includes(s.agentId) && s.inputTemplate.trim() !== '');

  // Validate that all steps have required fields
  const invalidSteps = validated.filter(s => !s.id || !s.agentId || !s.stepName || !s.inputTemplate);
  if (invalidSteps.length > 0) {
    res.status(422).json({
      error: 'Generated workflow has invalid steps',
      hint: 'Some steps are missing required fields (id, agentId, stepName, or inputTemplate)',
      invalidSteps,
    });
    return;
  }

  res.json({ data: { steps: validated } });
}));

export default router;
