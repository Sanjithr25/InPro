import { Router } from 'express';
import { z } from 'zod';
import db from '../db/client.js';

const router: Router = Router();

// Wrap async handlers
const handle = (fn: (req: any, res: any) => Promise<any>) => (req: any, res: any, next: any) => fn(req, res).catch(next);

// GET /api/settings
router.get('/', handle(async (_req, res) => {
  const { rows } = await db.query('SELECT setting_key, setting_value FROM global_settings');
  const result: Record<string, any> = {};
  for (const row of rows) {
    result[row.setting_key] = row.setting_value;
  }
  res.json({ data: result });
}));

// POST /api/settings
const SettingUpdate = z.object({
  key: z.string(),
  value: z.any()
});

router.post('/', handle(async (req, res) => {
  const parsed = SettingUpdate.parse(req.body);
  await db.query(
    `INSERT INTO global_settings (setting_key, setting_value, updated_at) 
     VALUES ($1, $2, NOW()) 
     ON CONFLICT (setting_key) 
     DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [parsed.key, JSON.stringify(parsed.value)]
  );
  res.json({ data: { success: true } });
}));

export default router;
