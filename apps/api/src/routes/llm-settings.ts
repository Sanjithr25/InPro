import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// GET /api/llm-settings
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, provider, base_url, model_name, is_default, extra_params, updated_at,
            CASE WHEN api_key = '' THEN false ELSE true END AS has_key
     FROM llm_settings ORDER BY is_default DESC, provider`
  );
  res.json({ data: rows });
}));

const UpdateSettingSchema = z.object({
  api_key:      z.string().optional(),
  base_url:     z.string().url().nullish(),
  model_name:   z.string().optional(),
  is_default:   z.boolean().optional(),
  extra_params: z.record(z.unknown()).optional(),
});

// PUT /api/llm-settings/:id
router.put('/:id', handle(async (req, res) => {
  const parsed = UpdateSettingSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { is_default, ...rest } = parsed.data;

  if (is_default) {
    await pool.query(`UPDATE llm_settings SET is_default = false WHERE is_default = true`);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) {
      sets.push(`${k} = $${i++}`);
      vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
  }
  if (is_default !== undefined) { sets.push(`is_default = $${i++}`); vals.push(is_default); }
  sets.push(`updated_at = NOW()`);
  vals.push(req.params.id);

  await pool.query(`UPDATE llm_settings SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json({ data: { updated: true } });
}));

// POST /api/llm-settings (add new provider)
const CreateSettingSchema = z.object({
  provider:     z.enum(['anthropic','openai','gemini','ollama']),
  api_key:      z.string().default(''),
  base_url:     z.string().url().nullish(),
  model_name:   z.string().min(1),
  is_default:   z.boolean().default(false),
  extra_params: z.record(z.unknown()).default({}),
});

router.post('/', handle(async (req, res) => {
  const parsed = CreateSettingSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { provider, api_key, base_url, model_name, is_default, extra_params } = parsed.data;

  if (is_default) {
    await pool.query(`UPDATE llm_settings SET is_default = false WHERE is_default = true`);
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO llm_settings (id, provider, api_key, base_url, model_name, is_default, extra_params)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, provider, api_key, base_url ?? null, model_name, is_default, JSON.stringify(extra_params)]
  );
  res.status(201).json({ data: { id } });
}));

export default router;
