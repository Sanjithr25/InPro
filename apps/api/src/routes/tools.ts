import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { BUILT_IN_TOOLS } from '../engine/builtins.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── GET /api/tools/builtins ─────────────────────────────────────────────────
// Returns the catalog of built-in tools (without execute functions).
router.get('/builtins', handle(async (_req, res) => {
  const catalog = BUILT_IN_TOOLS.map(({ execute: _exec, ...rest }) => rest);
  res.json({ data: catalog });
}));

// ─── POST /api/tools/builtins/:name/install ───────────────────────────────────
// Installs a built-in tool into the user's tool library (inserts into DB).
// Idempotent: if a tool with this name already exists, returns the existing id.
router.post('/builtins/:name/install', handle(async (req, res) => {
  const tool = BUILT_IN_TOOLS.find(t => t.name === req.params.name);
  if (!tool) { res.status(404).json({ error: `No built-in tool named "${req.params.name}"` }); return; }

  const { execute: _exec, icon: _icon, tagline: _tagline, category: _cat, ...rest } = tool;

  // Check if already installed
  const existing = await pool.query(`SELECT id FROM tools WHERE name = $1`, [rest.name]);
  if (existing.rows.length > 0) {
    res.json({ data: { id: existing.rows[0].id, installed: false, note: 'Already installed' } });
    return;
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO tools (id, name, description, schema, config, is_enabled) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, rest.name, rest.description, JSON.stringify(rest.schema), JSON.stringify(rest.defaultConfig), true]
  );
  res.status(201).json({ data: { id, installed: true } });
}));

// GET /api/tools
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, is_enabled, created_at FROM tools ORDER BY name`
  );
  res.json({ data: rows });
}));

// GET /api/tools/:id
router.get('/:id', handle(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, schema, is_enabled, created_at FROM tools WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Tool not found' }); return; }
  res.json({ data: rows[0] });
}));

const ToolSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().default(''),
  schema: z.record(z.unknown()).default({}),
  config: z.record(z.unknown()).default({}),
  is_enabled: z.boolean().default(true),
});

// POST /api/tools
router.post('/', handle(async (req, res) => {
  const parsed = ToolSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { name, description, schema, config, is_enabled } = parsed.data;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO tools (id, name, description, schema, config, is_enabled) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, name, description, JSON.stringify(schema), JSON.stringify(config), is_enabled]
  );
  res.status(201).json({ data: { id } });
}));

// PUT /api/tools/:id
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

// DELETE /api/tools/:id
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM tools WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

export default router;
