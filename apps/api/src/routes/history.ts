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
      COALESCE(child_counts.count, 0) AS child_count
    FROM execution_runs er
    LEFT JOIN tasks     t ON t.id = er.node_id AND er.node_type = 'task'
    LEFT JOIN schedules s ON s.id = er.node_id AND er.node_type = 'schedule'
    LEFT JOIN (
      SELECT parent_run_id, COUNT(*) as count
      FROM execution_runs
      WHERE parent_run_id IS NOT NULL
      GROUP BY parent_run_id
    ) child_counts ON child_counts.parent_run_id = er.id
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

// ─── GET /api/history/:id/stream ──────────────────────────────────────────────
// SSE streaming endpoint for real-time run output
router.get('/:id/stream', (req: Request, res: Response) => {
  const runId = req.params.id;
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connection event
  send('connected', { runId });

  // Poll for updates every 500ms
  const interval = setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT status, output_data, error_message FROM execution_runs WHERE id = $1`,
        [runId]
      );

      if (rows.length === 0) {
        send('error', { message: 'Run not found' });
        clearInterval(interval);
        res.end();
        return;
      }

      const run = rows[0];
      
      // Send current status
      send('status', { status: run.status });

      // If completed or failed, send final data and close
      if (run.status === 'completed' || run.status === 'failed') {
        if (run.output_data) {
          send('output', run.output_data);
        }
        if (run.error_message) {
          send('error', { message: run.error_message });
        }
        send('done', { status: run.status });
        clearInterval(interval);
        res.end();
      }
    } catch (err: any) {
      send('error', { message: err.message });
      clearInterval(interval);
      res.end();
    }
  }, 500);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

export default router;
