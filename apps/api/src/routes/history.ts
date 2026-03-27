/**
 * /api/history — Unified run history (tasks + schedules)
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/history          — list all top-level runs (task + schedule)
 * GET  /api/history/:id      — single run with children
 * DELETE /api/history/:id    — delete run + children
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import pool from '../db/client.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── GET /api/history ─────────────────────────────────────────────────────────
// Returns top-level runs: node_type IN ('task','schedule') with no parent
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      er.id,
      er.node_type,
      er.node_id,
      er.status,
      er.input_data,
      er.output_data,
      er.error_message,
      er.started_at,
      er.ended_at,
      er.created_at,
      EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds,
      CASE
        WHEN er.node_type = 'task'     THEN t.name
        WHEN er.node_type = 'schedule' THEN s.name
      END AS source_name,
      (
        SELECT COUNT(*) FROM execution_runs child
        WHERE child.parent_run_id = er.id
      ) AS child_count
    FROM execution_runs er
    LEFT JOIN tasks     t ON t.id = er.node_id AND er.node_type = 'task'
    LEFT JOIN schedules s ON s.id = er.node_id AND er.node_type = 'schedule'
    WHERE er.node_type IN ('task','schedule')
      AND er.parent_run_id IS NULL
    ORDER BY er.created_at DESC
    LIMIT 500
  `);
  res.json({ data: rows });
}));

// ─── GET /api/history/:id ─────────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows: runRows } = await pool.query(`
    SELECT
      er.id, er.node_type, er.node_id, er.status,
      er.input_data, er.output_data, er.error_message,
      er.started_at, er.ended_at, er.created_at,
      EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds,
      CASE
        WHEN er.node_type = 'task'     THEN t.name
        WHEN er.node_type = 'schedule' THEN s.name
      END AS source_name
    FROM execution_runs er
    LEFT JOIN tasks     t ON t.id = er.node_id AND er.node_type = 'task'
    LEFT JOIN schedules s ON s.id = er.node_id AND er.node_type = 'schedule'
    WHERE er.id = $1
  `, [req.params.id]);

  if (runRows.length === 0) { res.status(404).json({ error: 'Run not found' }); return; }
  const run = runRows[0];

  // For schedule runs: fetch child task runs
  // For task runs: fetch child agent runs
  let children: unknown[] = [];

  if (run.node_type === 'schedule') {
    const { rows } = await pool.query(`
      SELECT
        er.id, er.node_type, er.node_id, er.status,
        er.input_data, er.output_data, er.error_message,
        er.started_at, er.ended_at,
        EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds,
        t.name AS task_name,
        (SELECT COUNT(*) FROM execution_runs c WHERE c.parent_run_id = er.id) AS agent_count
      FROM execution_runs er
      LEFT JOIN tasks t ON t.id = er.node_id
      WHERE er.parent_run_id = $1 AND er.node_type = 'task'
      ORDER BY er.started_at ASC
    `, [req.params.id]);
    children = rows;
  } else if (run.node_type === 'task') {
    const { rows } = await pool.query(`
      SELECT
        er.id, er.node_type, er.node_id, er.status,
        er.input_data, er.output_data, er.error_message,
        er.started_at, er.ended_at,
        EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds,
        a.name AS agent_name,
        a.agent_group,
        a.skill AS agent_skill
      FROM execution_runs er
      LEFT JOIN agents a ON a.id = er.node_id
      WHERE er.parent_run_id = $1 AND er.node_type = 'agent'
      ORDER BY er.started_at ASC
    `, [req.params.id]);
    children = rows;
  }

  res.json({ data: { ...run, children } });
}));

// ─── DELETE /api/history/:id ──────────────────────────────────────────────────
router.delete('/:id', handle(async (req, res) => {
  // Recursively delete: grandchildren first, then children, then parent
  await pool.query(`
    DELETE FROM execution_runs
    WHERE parent_run_id IN (
      SELECT id FROM execution_runs WHERE parent_run_id = $1
    )
  `, [req.params.id]);
  await pool.query(`DELETE FROM execution_runs WHERE parent_run_id = $1`, [req.params.id]);
  await pool.query(`DELETE FROM execution_runs WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

export default router;
