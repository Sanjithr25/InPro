/**
 * /api/tools — Tool CRUD
 * ─────────────────────────────────────────────────────────────────────────────
 * GET    /api/tools        — list all tools (annotated with is_builtin)
 * GET    /api/tools/:id   — single tool (full schema + config)
 * POST   /api/tools        — create new tool
 * PUT    /api/tools/:id   — update tool
 * DELETE /api/tools/:id   — delete tool
 *
 * Built-in tools are pre-seeded by ToolRegistry.seed() on startup.
 * They appear in the list as regular rows — no separate install flow.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { ToolRegistry } from '../engine/ToolRegistry.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const builtInNames = ToolRegistry.getBuiltInNames();

// ─── GET /api/tools ──────────────────────────────────────────────────────────
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, tool_group, is_enabled, created_at FROM tools ORDER BY name`
  );
  const data = rows.map(r => ({
    ...r,
    is_builtin: builtInNames.has(r.name),
  }));
  res.json({ data });
}));

// ─── GET /api/tools/:id ──────────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, tool_group, schema, config, is_enabled, created_at FROM tools WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Tool not found' }); return; }
  const row = rows[0];
  res.json({ data: { ...row, is_builtin: builtInNames.has(row.name) } });
}));

// ─── Validation ───────────────────────────────────────────────────────────────
const ToolSchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().default(''),
  tool_group:  z.string().default('General'),
  schema:      z.record(z.unknown()).default({}),
  config:      z.record(z.unknown()).default({}),
  is_enabled:  z.boolean().default(true),
});

// ─── POST /api/tools ─────────────────────────────────────────────────────────
router.post('/', handle(async (req, res) => {
  const parsed = ToolSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { name, description, tool_group, schema, config, is_enabled } = parsed.data;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO tools (id, name, description, tool_group, schema, config, is_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name, description, tool_group, JSON.stringify(schema), JSON.stringify(config), is_enabled]
  );
  res.status(201).json({ data: { id } });
}));

// ─── PUT /api/tools/:id ──────────────────────────────────────────────────────
router.put('/:id', handle(async (req, res) => {
  const parsed = ToolSchema.partial().safeParse(req.body);
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
  vals.push(req.params.id);
  await pool.query(`UPDATE tools SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json({ data: { updated: true } });
}));

// ─── DELETE /api/tools/:id ───────────────────────────────────────────────────
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM tools WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

export default router;
