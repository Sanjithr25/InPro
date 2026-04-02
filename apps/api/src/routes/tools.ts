import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import pool from '../db/client.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── GET /api/tools ──────────────────────────────────────────────────────────
// Only returns the strictly controlled inventory of tools.
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, tool_group, risk_level, is_enabled FROM tools ORDER BY tool_group, name`
  );
  res.json({ data: rows });
}));

// ─── Validation ───────────────────────────────────────────────────────────────
const ToolToggleSchema = z.object({
  is_enabled:  z.boolean().optional(),
  description: z.string().optional(),
  risk_level:  z.enum(['low', 'high']).optional(),
});

// ─── PUT /api/tools/:id ──────────────────────────────────────────────────────
router.put('/:id', handle(async (req, res) => {
  const parsed = ToolToggleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  
  if (parsed.data.is_enabled !== undefined) {
    sets.push(`is_enabled = $${i++}`);
    vals.push(parsed.data.is_enabled);
  }
  if (parsed.data.description !== undefined) {
    sets.push(`description = $${i++}`);
    vals.push(parsed.data.description);
  }
  if (parsed.data.risk_level !== undefined) {
    sets.push(`risk_level = $${i++}`);
    vals.push(parsed.data.risk_level);
  }

  if (sets.length === 0) { res.json({ data: { updated: false } }); return; }
  
  vals.push(req.params.id);
  await pool.query(`UPDATE tools SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json({ data: { updated: true } });
}));

export default router;
