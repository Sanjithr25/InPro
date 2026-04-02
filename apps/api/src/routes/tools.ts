/**
 * /api/tools  — Tool management (list, update)
 * /api/fs     — Filesystem browser for directory picker
 * /api/settings — Global settings (global_settings table)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname, parse } from 'node:path';
import { homedir } from 'node:os';
import pool from '../db/client.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── Tools ────────────────────────────────────────────────────────────────────

// GET /api/tools
router.get('/tools', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, tool_group, risk_level, is_enabled, schema, setting_key
     FROM tools ORDER BY tool_group, name`
  );
  res.json({ data: rows });
}));

const ToolUpdateSchema = z.object({
  is_enabled:  z.boolean().optional(),
  description: z.string().optional(),
  risk_level:  z.enum(['low', 'high']).optional(),
});

// PUT /api/tools/:id
router.put('/tools/:id', handle(async (req, res) => {
  const parsed = ToolUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (parsed.data.is_enabled  !== undefined) { sets.push(`is_enabled  = $${i++}`); vals.push(parsed.data.is_enabled); }
  if (parsed.data.description !== undefined) { sets.push(`description = $${i++}`); vals.push(parsed.data.description); }
  if (parsed.data.risk_level  !== undefined) { sets.push(`risk_level  = $${i++}`); vals.push(parsed.data.risk_level); }

  if (sets.length === 0) { res.json({ data: { updated: false } }); return; }

  vals.push(req.params.id);
  await pool.query(`UPDATE tools SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json({ data: { updated: true } });
}));

// ─── Filesystem Browser ───────────────────────────────────────────────────────
// Used by the directory picker in the Tools / Global Settings page.

async function listDirs(dirPath: string) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      dirs.push({ name: e.name, path: join(dirPath, e.name) });
    }
  }
  return dirs;
}

// GET /api/fs/home
router.get('/fs/home', (_req, res) => {
  const home = homedir();
  res.json({ data: { home, documents: join(home, 'Documents'), desktop: join(home, 'Desktop') } });
});

// GET /api/fs/browse?path=...
router.get('/fs/browse', handle(async (req, res) => {
  const requestedPath = (req.query.path as string) || join(homedir(), 'Documents');
  try {
    const s = await stat(requestedPath);
    if (!s.isDirectory()) { res.status(400).json({ error: 'Path is not a directory' }); return; }
    const children = await listDirs(requestedPath);
    const parsed = parse(requestedPath);
    const parent = parsed.root === requestedPath ? null : dirname(requestedPath);
    res.json({ data: { current: requestedPath, parent, is_root: parsed.root === requestedPath, children } });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}));

// ─── Global Settings ──────────────────────────────────────────────────────────

// GET /api/settings
router.get('/settings', handle(async (_req, res) => {
  const { rows } = await pool.query('SELECT setting_key, setting_value FROM global_settings');
  const result: Record<string, any> = {};
  for (const row of rows) result[row.setting_key] = row.setting_value;
  res.json({ data: result });
}));

const SettingUpdateSchema = z.object({ key: z.string(), value: z.any() });

// POST /api/settings
router.post('/settings', handle(async (req, res) => {
  const { key, value } = SettingUpdateSchema.parse(req.body);
  await pool.query(
    `INSERT INTO global_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key)
     DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
  res.json({ data: { success: true } });
}));

export default router;
