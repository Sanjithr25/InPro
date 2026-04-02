import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { LLMProviderFactory } from '../engine/LLMProviderFactory.js';
import type { LLMProviderName } from '../types.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// GET /api/llm-settings
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, provider, base_url, model_name, is_default, extra_params, max_turns, timeout_ms, temperature, updated_at,
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
  max_turns:    z.number().int().positive().optional(),
  timeout_ms:   z.number().int().nonnegative().optional(),
  temperature:  z.number().min(0).max(2).optional(),
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
  provider:     z.enum(['llama-local','ollama','groq','gemini','openai','anthropic','custom']),
  api_key:      z.string().default(''),
  base_url:     z.string().url().nullish(),
  model_name:   z.string().min(1),
  is_default:   z.boolean().default(false),
  extra_params: z.record(z.unknown()).default({}),
  max_turns:    z.number().int().positive().optional(),
  timeout_ms:   z.number().int().nonnegative().optional(),
  temperature:  z.number().min(0).max(2).optional(),
});

router.post('/', handle(async (req, res) => {
  const parsed = CreateSettingSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { provider, api_key, base_url, model_name, is_default, extra_params, max_turns, timeout_ms, temperature } = parsed.data;

  if (is_default) {
    await pool.query(`UPDATE llm_settings SET is_default = false WHERE is_default = true`);
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO llm_settings (id, provider, api_key, base_url, model_name, is_default, extra_params, max_turns, timeout_ms, temperature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, provider, api_key, base_url ?? null, model_name, is_default, JSON.stringify(extra_params), max_turns ?? null, timeout_ms ?? null, temperature ?? null]
  );
  res.status(201).json({ data: { id } });
}));

// GET /api/llm-settings/provider-requirements/:provider
router.get('/provider-requirements/:provider', handle(async (req, res) => {
  const provider = req.params.provider as LLMProviderName;
  try {
    const requirements = LLMProviderFactory.getRequirements(provider);
    res.json({ data: requirements });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// GET /api/llm-settings/providers (list all supported providers)
router.get('/providers', handle(async (_req, res) => {
  const providers = [
    { name: 'llama-local', label: 'Llama Local (System)', description: 'System-provided local Llama model' },
    { name: 'ollama', label: 'Ollama Cloud', description: 'User-configured Ollama cloud instance' },
    { name: 'groq', label: 'Groq', description: 'Groq fast inference API' },
    { name: 'gemini', label: 'Google Gemini', description: 'Google Gemini API' },
    { name: 'openai', label: 'OpenAI', description: 'OpenAI GPT models' },
    { name: 'anthropic', label: 'Anthropic Claude', description: 'Anthropic Claude models' },
    { name: 'custom', label: 'Custom Endpoint', description: 'Any OpenAI-compatible API endpoint' },
  ];
  res.json({ data: providers });
}));

// DELETE /api/llm-settings/:id
router.delete('/:id', handle(async (req, res) => {
  const { id } = req.params;

  // Check if this provider is set as default
  const checkDefault = await pool.query(
    `SELECT is_default FROM llm_settings WHERE id = $1`,
    [id]
  );

  if (checkDefault.rows.length === 0) {
    res.status(404).json({ error: 'LLM setting not found' });
    return;
  }

  const isDefault = checkDefault.rows[0].is_default;

  // Prevent deletion if it's the default and it's the only provider
  if (isDefault) {
    const countResult = await pool.query(`SELECT COUNT(*) as count FROM llm_settings`);
    const totalProviders = parseInt(countResult.rows[0].count, 10);

    if (totalProviders === 1) {
      res.status(400).json({ 
        error: 'Cannot delete the only LLM provider. Add another provider first or set a different one as default.' 
      });
      return;
    }

    // If deleting default, set another provider as default
    await pool.query(
      `UPDATE llm_settings 
       SET is_default = true 
       WHERE id != $1 
       LIMIT 1`,
      [id]
    );
  }

  // Check if any agents are using this provider
  const agentsUsing = await pool.query(
    `SELECT COUNT(*) as count FROM agents WHERE llm_provider_id = $1`,
    [id]
  );

  const agentCount = parseInt(agentsUsing.rows[0].count, 10);

  if (agentCount > 0) {
    // Set those agents to use NULL (will fall back to default)
    await pool.query(
      `UPDATE agents SET llm_provider_id = NULL WHERE llm_provider_id = $1`,
      [id]
    );
  }

  // Delete the provider
  await pool.query(`DELETE FROM llm_settings WHERE id = $1`, [id]);

  res.json({ 
    data: { 
      deleted: true, 
      agentsUpdated: agentCount,
      message: agentCount > 0 
        ? `Provider deleted. ${agentCount} agent(s) will now use the default provider.`
        : 'Provider deleted successfully.'
    } 
  });
}));

export default router;
