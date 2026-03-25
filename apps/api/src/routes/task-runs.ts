import { Router, type Request, type Response, type NextFunction } from 'express';
import pool from '../db/client.js';
import { TaskNode } from '../engine/TaskNode.js';
import type { ExecutionContext } from '../types.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── In-memory kill registry ──────────────────────────────────────────────────
// Maps run_id -> AbortController so we can cancel a running task
const activeRuns = new Map<string, AbortController>();

export function registerRun(runId: string, controller: AbortController) {
  activeRuns.set(runId, controller);
}
export function unregisterRun(runId: string) {
  activeRuns.delete(runId);
}

/**
 * On startup, find any runs marked as 'running' and mark them as failed.
 * Since we run in-process, if the server restarts, all active runs are lost.
 */
export async function reconcileRuns() {
  const { rowCount } = await pool.query(`
    UPDATE execution_runs 
    SET status = 'failed', 
        ended_at = NOW(), 
        error_message = 'Process terminated unexpectedly (server restart)' 
    WHERE status = 'running'
  `);
  if (rowCount && rowCount > 0) {
    console.log(`[Reconciler] Marked ${rowCount} stale runs as failed.`);
  }
}

// ─── GET /api/task-runs ── list runs with task name + stats ──────────────────
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      er.id,
      er.node_id    AS task_id,
      t.name        AS task_name,
      er.status,
      er.input_data,
      er.output_data,
      er.error_message,
      er.started_at,
      er.ended_at,
      er.created_at,
      EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds,
      (
        SELECT COUNT(*) FROM execution_runs child
        WHERE child.parent_run_id = er.id AND child.node_type = 'agent'
      ) AS agent_runs_count
    FROM execution_runs er
    LEFT JOIN tasks t ON t.id = er.node_id
    WHERE er.node_type = 'task'
    ORDER BY er.created_at DESC
    LIMIT 200
  `);
  // Annotate which runs are currently active (killable)
  const withActive = rows.map(r => ({ ...r, is_active: activeRuns.has(r.id) }));
  res.json({ data: withActive });
}));

// ─── GET /api/task-runs/:id ── single run with agent sub-runs ────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows: runRows } = await pool.query(`
    SELECT
      er.id, er.node_id AS task_id, t.name AS task_name,
      er.status, er.input_data, er.output_data, er.error_message,
      er.started_at, er.ended_at, er.created_at,
      EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds
    FROM execution_runs er
    LEFT JOIN tasks t ON t.id = er.node_id
    WHERE er.id = $1 AND er.node_type = 'task'
  `, [req.params.id]);

  if (runRows.length === 0) { res.status(404).json({ error: 'Run not found' }); return; }

  const { rows: childRows } = await pool.query(`
    SELECT
      er.id, er.node_id AS agent_id, a.name AS agent_name,
      er.status, er.input_data, er.output_data, er.error_message,
      er.started_at, er.ended_at,
      EXTRACT(EPOCH FROM (COALESCE(er.ended_at, NOW()) - er.started_at))::int AS duration_seconds
    FROM execution_runs er
    LEFT JOIN agents a ON a.id = er.node_id
    WHERE er.parent_run_id = $1 AND er.node_type = 'agent'
    ORDER BY er.started_at ASC
  `, [req.params.id]);

  res.json({ data: { ...runRows[0], agent_runs: childRows } });
}));

// ─── POST /api/task-runs ── trigger a new task run ───────────────────────────
router.post('/', handle(async (req, res) => {
  const { task_id, prompt } = z.object({
    task_id: z.string().uuid(),
    prompt: z.string().default(''),
  }).parse(req.body);

  const runId = uuidv4(); // Generate upfront
  const controller = new AbortController();

  const ctx: ExecutionContext = {
    // Pass runId into inputData so TaskNode uses it instead of uuidv4()
    inputData: { taskId: task_id, initialPrompt: prompt, runId },
    currentDepth: 0,
    totalSteps: 0,
    maxDepth: 10,
    parentRunId: null,
    abortSignal: controller.signal,
  };

  const taskNode = new TaskNode();

  // Register the run immediately so it's killable even in the first millisecond
  registerRun(runId, controller);

  // 1. Create the database record SYNCHRONOUSLY before responding.
  // This ensures the frontend's first polling request will find the record.
  await pool.query(
    `INSERT INTO execution_runs
      (id, node_type, node_id, parent_run_id, status, input_data, started_at)
     VALUES ($1, 'task', $2, $3, 'running', $4, NOW())`,
    [runId, task_id, ctx.parentRunId ?? null, JSON.stringify({ taskId: task_id, initialPrompt: prompt, runId })]
  );

  // 2. Start the autonomous execution loop in the background
  taskNode.execute(ctx)
    .then(() => unregisterRun(runId))
    .catch(() => unregisterRun(runId));

  res.json({ data: { run_id: runId, status: 'started' } });
}));

// ─── POST /api/task-runs/:id/kill ── abort a running task ───────────────────
router.post('/:id/kill', handle(async (req, res) => {
  const id = req.params.id as string;
  const controller = activeRuns.get(id);
  if (controller) {
    controller.abort();
    activeRuns.delete(id);
    // Mark as cancelled in DB
    await pool.query(
      `UPDATE execution_runs SET status = 'failed', ended_at = NOW(), error_message = 'Killed by user' WHERE id = $1`,
      [id]
    );
    await pool.query(
      `UPDATE execution_runs SET status = 'failed', ended_at = NOW(), error_message = 'Parent task killed' WHERE parent_run_id = $1 AND status = 'running'`,
      [id]
    );
    res.json({ data: { killed: true } });
  } else {
    res.status(404).json({ error: 'No active run with that ID (already finished or not found)' });
  }
}));

// ─── DELETE /api/task-runs/:id ── delete run record ─────────────────────────
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM execution_runs WHERE parent_run_id = $1`, [req.params.id]);
  await pool.query(`DELETE FROM execution_runs WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

export default router;
