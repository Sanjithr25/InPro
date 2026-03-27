/**
 * /api/schedules — Schedule CRUD + toggle + status
 * ─────────────────────────────────────────────────────────────────────────────
 * GET    /api/schedules              — list all schedules with task names + status
 * GET    /api/schedules/:id          — single schedule (full)
 * POST   /api/schedules              — create schedule
 * PUT    /api/schedules/:id          — update schedule
 * DELETE /api/schedules/:id          — delete schedule
 * POST   /api/schedules/:id/toggle   — enable/disable
 * POST   /api/schedules/:id/run      — manual trigger (run now)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { schedulerService, computeNextRun } from '../engine/SchedulerService.js';
import { logger } from '../utils/logger.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const pid = (req: Request) => req.params['id'] as string;

// ─── Validation ───────────────────────────────────────────────────────────────
const TriggerConfigSchema = z.object({
  cron:            z.string().optional(),
  intervalMinutes: z.number().int().positive().optional(),
  runAt:           z.string().optional(),
}).default({});

const ScheduleSchema = z.object({
  name:           z.string().min(1).max(200),
  trigger_type:   z.enum(['cron', 'interval', 'one_time', 'manual']),
  trigger_config: TriggerConfigSchema,
  is_enabled:     z.boolean().default(true),
  task_ids:       z.array(z.string().uuid()).default([]),
});

// ─── Shared list query ────────────────────────────────────────────────────────
async function querySchedules(whereClause = '', params: unknown[] = []) {
  const sql = `
    SELECT
      s.id, s.name, s.trigger_type, s.trigger_config,
      s.is_enabled, s.last_run_at, s.last_run_status, s.next_run_at,
      s.created_at, s.updated_at,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT('id', t.id, 'name', t.name)
          ORDER BY st.order_index
        ) FILTER (WHERE t.id IS NOT NULL),
        '[]'
      ) AS tasks
    FROM schedules s
    LEFT JOIN schedule_tasks st ON st.schedule_id = s.id
    LEFT JOIN tasks t ON t.id = st.task_id
    ${whereClause}
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `;
  return pool.query(sql, params);
}

// ─── GET /api/schedules ───────────────────────────────────────────────────────
router.get('/', handle(async (_req, res) => {
  const { rows } = await querySchedules();
  res.json({ data: rows });
}));

// ─── GET /api/schedules/:id ───────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows } = await querySchedules('WHERE s.id = $1', [pid(req)]);
  if (rows.length === 0) { res.status(404).json({ error: 'Schedule not found' }); return; }
  res.json({ data: rows[0] });
}));

// ─── POST /api/schedules ──────────────────────────────────────────────────────
router.post('/', handle(async (req, res) => {
  const parsed = ScheduleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { name, trigger_type, trigger_config, is_enabled, task_ids } = parsed.data;

  const id = uuidv4();
  const next = is_enabled ? computeNextRun({ trigger_type, trigger_config }) : null;

  await pool.query(
    `INSERT INTO schedules (id, name, trigger_type, trigger_config, is_enabled, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, name, trigger_type, JSON.stringify(trigger_config), is_enabled, next?.toISOString() ?? null]
  );

  if (task_ids.length > 0) {
    const vals = task_ids.map((_t, i) => `($1, $${i + 2}, ${i})`).join(', ');
    await pool.query(
      `INSERT INTO schedule_tasks (schedule_id, task_id, order_index) VALUES ${vals}`,
      [id, ...task_ids]
    );
  }

  if (is_enabled) await schedulerService.reschedule(id);
  res.status(201).json({ data: { id } });
}));

// ─── PUT /api/schedules/:id ───────────────────────────────────────────────────
router.put('/:id', handle(async (req, res) => {
  const id = pid(req);
  const parsed = ScheduleSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { task_ids, ...fields } = parsed.data;

  // Recompute next_run_at if trigger changed
  if (fields.trigger_type || fields.trigger_config) {
    const { rows } = await pool.query(
      `SELECT trigger_type, trigger_config, is_enabled FROM schedules WHERE id = $1`, [id]
    );
    if (rows.length > 0) {
      const merged = {
        trigger_type:   fields.trigger_type   ?? rows[0].trigger_type,
        trigger_config: fields.trigger_config ?? rows[0].trigger_config,
      };
      const enabled = fields.is_enabled ?? rows[0].is_enabled;
      (fields as Record<string, unknown>).next_run_at = enabled
        ? (computeNextRun(merged)?.toISOString() ?? null)
        : null;
    }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) {
      sets.push(`${k} = $${i++}`);
      vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
  }
  if (sets.length > 0) {
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    await pool.query(`UPDATE schedules SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  }

  if (task_ids !== undefined) {
    await pool.query(`DELETE FROM schedule_tasks WHERE schedule_id = $1`, [id]);
    if (task_ids.length > 0) {
      const vStr = task_ids.map((_t, idx) => `($1, $${idx + 2}, ${idx})`).join(', ');
      await pool.query(
        `INSERT INTO schedule_tasks (schedule_id, task_id, order_index) VALUES ${vStr}`,
        [id, ...task_ids]
      );
    }
  }

  await schedulerService.reschedule(id);
  res.json({ data: { updated: true } });
}));

// ─── DELETE /api/schedules/:id ────────────────────────────────────────────────
router.delete('/:id', handle(async (req, res) => {
  const id = pid(req);
  schedulerService.unschedule(id);
  await pool.query(`DELETE FROM schedules WHERE id = $1`, [id]);
  res.json({ data: { deleted: true } });
}));

// ─── POST /api/schedules/:id/toggle ──────────────────────────────────────────
router.post('/:id/toggle', handle(async (req, res) => {
  const id = pid(req);
  const { rows } = await pool.query(
    `UPDATE schedules SET is_enabled = NOT is_enabled, updated_at = NOW() WHERE id = $1 RETURNING is_enabled`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Schedule not found' }); return; }
  const enabled = rows[0].is_enabled as boolean;
  if (enabled) {
    await schedulerService.reschedule(id);
  } else {
    schedulerService.unschedule(id);
    // Clear next_run_at and reset last_run_status if it was running
    await pool.query(`
      UPDATE schedules 
      SET next_run_at = NULL, 
          last_run_status = CASE 
            WHEN last_run_status = 'running' THEN 'failed' 
            ELSE last_run_status 
          END
      WHERE id = $1
    `, [id]);
  }
  res.json({ data: { is_enabled: enabled } });
}));

// ─── POST /api/schedules/:id/run ─────────────────────────────────────────────
router.post('/:id/run', handle(async (req, res) => {
  const id = pid(req);
  const { rows } = await pool.query(
    `SELECT s.id, ARRAY_AGG(st.task_id ORDER BY st.order_index) FILTER (WHERE st.task_id IS NOT NULL) AS task_ids
     FROM schedules s
     LEFT JOIN schedule_tasks st ON st.schedule_id = s.id
     WHERE s.id = $1 GROUP BY s.id`,
    [id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Schedule not found' }); return; }
  const taskIds: string[] = rows[0].task_ids ?? [];
  if (taskIds.length === 0) { res.status(400).json({ error: 'Schedule has no tasks assigned' }); return; }

  // Respond immediately, run in background
  res.json({ data: { triggered: true } });

  schedulerService.executeSchedule(id, taskIds)
    .catch(e => console.error('[Scheduler] Manual run error:', e));
}));

// ─── POST /api/schedules/:id/kill ────────────────────────────────────────────
router.post('/:id/kill', handle(async (req, res) => {
  const id = pid(req);
  
  // Get schedule name
  const { rows: schedRows } = await pool.query(`SELECT name FROM schedules WHERE id = $1`, [id]);
  const scheduleName = schedRows[0]?.name || 'Unknown Schedule';
  
  // Find the currently running schedule execution
  const { rows } = await pool.query(
    `SELECT id FROM execution_runs 
     WHERE node_type = 'schedule' AND node_id = $1 AND status = 'running' 
     ORDER BY started_at DESC LIMIT 1`,
    [id]
  );
  
  if (rows.length === 0) {
    res.status(404).json({ error: 'No active run found for this schedule' });
    return;
  }
  
  const scheduleRunId = rows[0].id;
  
  // Import the kill function from task-runs
  const { getActiveController } = await import('./task-runs.js');
  
  // Kill the schedule run tree (this will cascade to all tasks and agents)
  const controller = getActiveController(scheduleRunId);
  
  if (controller) {
    controller.abort();
    logger.scheduleKilled(scheduleName, id, scheduleRunId, 'user');
  }
  
  // Update all descendants in the tree
  const { rowCount } = await pool.query(`
    WITH RECURSIVE run_tree AS (
      SELECT id FROM execution_runs WHERE id = $1
      UNION ALL
      SELECT er.id FROM execution_runs er
      INNER JOIN run_tree rt ON er.parent_run_id = rt.id
    )
    UPDATE execution_runs
    SET status = 'failed', 
        ended_at = COALESCE(ended_at, NOW()), 
        error_message = 'Schedule killed by user'
    WHERE id IN (SELECT id FROM run_tree) AND status = 'running'
  `, [scheduleRunId]);
  
  // Update schedule status
  await pool.query(
    `UPDATE schedules SET last_run_status = 'failed' WHERE id = $1`,
    [id]
  );
  
  logger.info(`Killed schedule and updated ${rowCount || 0} execution records`, 'scheduler', {
    scheduleName,
    scheduleId: id,
    scheduleRunId,
  });
  
  res.json({ 
    data: { 
      killed: true, 
      schedule_id: id,
      schedule_run_id: scheduleRunId,
      db_records_updated: rowCount || 0,
      message: 'Schedule execution and all child tasks killed'
    } 
  });
}));

export default router;
