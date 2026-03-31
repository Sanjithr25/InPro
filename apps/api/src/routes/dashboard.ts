/**
 * /api/dashboard — Operational dashboard data
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/dashboard  — Real-time operational metrics
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import pool from '../db/client.js';
import { getAllActiveRunIds } from './task-runs.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── GET /api/dashboard ───────────────────────────────────────────────────────
router.get('/', handle(async (_req, res) => {
  // 1. Active runs count (from in-memory registry)
  const activeRunIds = getAllActiveRunIds();
  const activeCount = activeRunIds.length;

  // 2. Failed runs in last 24 hours
  const { rows: failedRows } = await pool.query(`
    SELECT COUNT(*) as count
    FROM execution_runs
    WHERE status = 'failed'
      AND node_type IN ('task', 'schedule')
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  const failedCount = parseInt(failedRows[0]?.count || '0', 10);

  // 3. Enabled schedules count
  const { rows: scheduleRows } = await pool.query(`
    SELECT COUNT(*) as count
    FROM schedules
    WHERE is_enabled = true
  `);
  const enabledSchedules = parseInt(scheduleRows[0]?.count || '0', 10);

  // 4. Recent activity (last 20 runs, running first)
  const { rows: activityRows } = await pool.query(`
    SELECT
      er.id,
      er.node_type,
      er.node_id,
      er.status,
      er.started_at,
      er.ended_at,
      er.error_message,
      EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds,
      CASE
        WHEN er.node_type = 'task' THEN t.name
        WHEN er.node_type = 'schedule' THEN s.name
      END AS name,
      CASE
        WHEN er.node_type = 'task' THEN (
          SELECT a.name
          FROM execution_runs child
          LEFT JOIN agents a ON a.id = child.node_id
          WHERE child.parent_run_id = er.id
            AND child.node_type = 'agent'
            AND child.status = 'running'
          ORDER BY child.started_at DESC
          LIMIT 1
        )
      END AS current_agent
    FROM execution_runs er
    LEFT JOIN tasks t ON t.id = er.node_id AND er.node_type = 'task'
    LEFT JOIN schedules s ON s.id = er.node_id AND er.node_type = 'schedule'
    WHERE er.node_type IN ('task', 'schedule')
      AND er.parent_run_id IS NULL
    ORDER BY
      CASE WHEN er.status = 'running' THEN 0 ELSE 1 END,
      er.created_at DESC
    LIMIT 20
  `);

  // 5. Recent failures (last 5)
  const { rows: failureRows } = await pool.query(`
    SELECT
      er.id,
      er.node_type,
      er.node_id,
      er.error_message,
      er.created_at,
      CASE
        WHEN er.node_type = 'task' THEN t.name
        WHEN er.node_type = 'schedule' THEN s.name
      END AS name,
      (
        SELECT a.name
        FROM execution_runs child
        LEFT JOIN agents a ON a.id = child.node_id
        WHERE child.parent_run_id = er.id
          AND child.node_type = 'agent'
          AND child.status = 'failed'
        ORDER BY child.started_at DESC
        LIMIT 1
      ) AS failed_agent
    FROM execution_runs er
    LEFT JOIN tasks t ON t.id = er.node_id AND er.node_type = 'task'
    LEFT JOIN schedules s ON s.id = er.node_id AND er.node_type = 'schedule'
    WHERE er.status = 'failed'
      AND er.node_type IN ('task', 'schedule')
      AND er.parent_run_id IS NULL
    ORDER BY er.created_at DESC
    LIMIT 5
  `);

  // 6. Next schedules (next 5)
  const { rows: nextSchedules } = await pool.query(`
    SELECT
      s.id,
      s.name,
      s.next_run_at,
      s.last_run_status,
      s.last_run_at
    FROM schedules s
    WHERE s.is_enabled = true
      AND s.next_run_at IS NOT NULL
    ORDER BY s.next_run_at ASC
    LIMIT 5
  `);

  res.json({
    data: {
      health: {
        active_runs: activeCount,
        failed_24h: failedCount,
        enabled_schedules: enabledSchedules,
        queue_status: 'healthy', // Could be enhanced with BullMQ metrics
      },
      activity: activityRows,
      failures: failureRows,
      next_schedules: nextSchedules,
    },
  });
}));

export default router;
