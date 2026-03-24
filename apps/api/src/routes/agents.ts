import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { AgentNode } from '../engine/AgentNode.js';
import type { ExecutionContext } from '../types.js';

const router = Router();

// Helper — wraps async handlers, propagates errors to Express error middleware
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// ─── GET /api/agents ──────────────────────────────────────────────────────────
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.skill, a.model_name, a.created_at,
            l.provider AS llm_provider, l.model_name AS provider_model
     FROM agents a
     LEFT JOIN llm_settings l ON a.llm_provider_id = l.id
     ORDER BY a.created_at DESC`
  );
  res.json({ data: rows });
}));

// ─── GET /api/agents/:id ──────────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.skill, a.model_name, a.created_at,
            l.provider AS llm_provider, l.id AS llm_provider_id,
            COALESCE(
              JSON_AGG(JSON_BUILD_OBJECT('id', t.id, 'name', t.name, 'description', t.description))
              FILTER (WHERE t.id IS NOT NULL), '[]'
            ) AS tools
     FROM agents a
     LEFT JOIN llm_settings l ON a.llm_provider_id = l.id
     LEFT JOIN agent_tools at2 ON a.id = at2.agent_id
     LEFT JOIN tools t ON at2.tool_id = t.id
     WHERE a.id = $1
     GROUP BY a.id, l.provider, l.id`,
    [req.params.id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json({ data: rows[0] });
}));

// ─── POST /api/agents ─────────────────────────────────────────────────────────
const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  skill: z.string().default(''),
  llm_provider_id: z.string().uuid().optional(),
  model_name: z.string().default(''),
  tool_ids: z.array(z.string().uuid()).default([]),
});

router.post('/', handle(async (req, res) => {
  const parsed = CreateAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { name, skill, llm_provider_id, model_name, tool_ids } = parsed.data;
  const id = uuidv4();

  await pool.query(
    `INSERT INTO agents (id, name, skill, llm_provider_id, model_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name, skill, llm_provider_id ?? null, model_name]
  );

  if (tool_ids.length > 0) {
    const values = tool_ids.map((_tid, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const params = tool_ids.flatMap((tid) => [id, tid]);
    await pool.query(`INSERT INTO agent_tools (agent_id, tool_id) VALUES ${values}`, params);
  }

  res.status(201).json({ data: { id } });
}));

// ─── PUT /api/agents/:id ──────────────────────────────────────────────────────
const UpdateAgentSchema = CreateAgentSchema.partial();

router.put('/:id', handle(async (req, res) => {
  const parsed = UpdateAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { tool_ids, ...fields } = parsed.data;
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) {
      updates.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }

  if (updates.length > 0) {
    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);
    await pool.query(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${idx}`, values);
  }

  if (tool_ids !== undefined) {
    await pool.query(`DELETE FROM agent_tools WHERE agent_id = $1`, [req.params.id]);
    if (tool_ids.length > 0) {
      const vals = tool_ids.map((_tid, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
      const params = tool_ids.flatMap((tid) => [req.params.id, tid]);
      await pool.query(`INSERT INTO agent_tools (agent_id, tool_id) VALUES ${vals}`, params);
    }
  }

  res.json({ data: { updated: true } });
}));

// ─── DELETE /api/agents/:id ───────────────────────────────────────────────────
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM agents WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

// ─── POST /api/agents/:id/run ─────────────────────────────────────────────────
const DryRunSchema = z.object({ prompt: z.string().min(1) });

router.post('/:id/run', handle(async (req, res) => {
  const parsed = DryRunSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const context: ExecutionContext = {
    inputData: { prompt: parsed.data.prompt },
    currentDepth: 0,
    totalSteps: 1,
    maxDepth: 5,
    parentRunId: null,
  };

  const agentNode = new AgentNode(agentId);
  const result = await agentNode.execute(context);
  res.json({ data: result });
}));

export default router;
