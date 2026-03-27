import { Router, type Request, type Response, type NextFunction } from 'express';
import pool from '../db/client.js';
import { TaskNode } from '../engine/TaskNode.js';
import type { ExecutionContext } from '../types.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

const router = Router();
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ─── In-Memory Execution Registry ─────────────────────────────────────────────
// Maps run_id -> AbortController for kill operations
const activeRuns = new Map<string, AbortController>();

export function registerRun(
  runId: string, 
  controller: AbortController, 
  nodeType?: 'schedule' | 'task' | 'agent', 
  nodeName?: string
) {
  activeRuns.set(runId, controller);
  
  if (nodeType && nodeName) {
    logger.debug(`Registered ${nodeType} execution`, 'system', { 
      runId: runId.substring(0, 8), 
      nodeType, 
      nodeName 
    });
  }
}

export function unregisterRun(runId: string, nodeType?: string, nodeName?: string) {
  activeRuns.delete(runId);
  
  if (nodeType && nodeName) {
    logger.debug(`Unregistered ${nodeType} execution`, 'system', { 
      runId: runId.substring(0, 8), 
      nodeType, 
      nodeName 
    });
  }
}

export function getActiveController(runId: string): AbortController | undefined {
  return activeRuns.get(runId);
}

export function getAllActiveRunIds(): string[] {
  return Array.from(activeRuns.keys());
}

/**
 * Recursively kill a run and all its descendants
 */
async function killRunTree(runId: string, reason: string = 'Killed by user'): Promise<{ controllersAborted: number; dbRecordsUpdated: number }> {
  logger.info('Starting kill tree operation', 'system', { 
    runId: runId.substring(0, 8), 
    reason 
  });
  
  let controllersAborted = 0;
  
  // Get all child runs recursively
  const { rows: children } = await pool.query(`
    WITH RECURSIVE run_tree AS (
      SELECT id, parent_run_id, node_type, status
      FROM execution_runs
      WHERE id = $1
      
      UNION ALL
      
      SELECT er.id, er.parent_run_id, er.node_type, er.status
      FROM execution_runs er
      INNER JOIN run_tree rt ON er.parent_run_id = rt.id
    )
    SELECT id, status FROM run_tree WHERE status = 'running'
  `, [runId]);
  
  // Abort all active controllers in the tree
  for (const child of children) {
    const controller = activeRuns.get(child.id);
    if (controller) {
      controller.abort();
      activeRuns.delete(child.id);
      controllersAborted++;
    }
  }
  
  // Update all running descendants in database
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
        error_message = $2
    WHERE id IN (SELECT id FROM run_tree) AND status = 'running'
  `, [runId, reason]);
  
  const dbRecordsUpdated = rowCount || 0;
  
  logger.killTree(runId, controllersAborted, dbRecordsUpdated);
  
  return { controllersAborted, dbRecordsUpdated };
}

/**
 * On startup, mark any runs still marked as 'running' as failed.
 * Since we use in-memory tracking, server restarts lose all active runs.
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
    logger.info('Marked stale runs as failed on startup', 'system', { count: rowCount });
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
      COALESCE(agent_counts.count, 0) AS agent_runs_count
    FROM execution_runs er
    LEFT JOIN tasks t ON t.id = er.node_id
    LEFT JOIN (
      SELECT parent_run_id, COUNT(*) as count
      FROM execution_runs
      WHERE node_type = 'agent' AND parent_run_id IS NOT NULL
      GROUP BY parent_run_id
    ) agent_counts ON agent_counts.parent_run_id = er.id
    WHERE er.node_type = 'task'
    ORDER BY er.created_at DESC
    LIMIT 200
  `);
  
  // Annotate which runs are currently active (killable)
  const activeRunIds = new Set(getAllActiveRunIds());
  
  // Check against the set (O(1) lookup)
  const withActive = rows.map(r => ({
    ...r,
    is_active: activeRunIds.has(r.id)
  }));
  
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

  // Get task name for logging
  const { rows: taskRows } = await pool.query(`SELECT name FROM tasks WHERE id = $1`, [task_id]);
  const taskName = taskRows[0]?.name || 'Unknown Task';

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
  registerRun(runId, controller, 'task', taskName);

  // 1. Create the database record SYNCHRONOUSLY before responding.
  // This ensures the frontend's first polling request will find the record.
  await pool.query(
    `INSERT INTO execution_runs
      (id, node_type, node_id, parent_run_id, status, input_data, started_at)
     VALUES ($1, 'task', $2, $3, 'running', $4, NOW())`,
    [runId, task_id, ctx.parentRunId ?? null, JSON.stringify({ taskId: task_id, initialPrompt: prompt, runId })]
  );

  logger.taskStart(taskName, task_id, runId, null);

  // 2. Start the autonomous execution loop in the background
  taskNode.execute(ctx)
    .then((result) => {
      const duration = 0; // Duration tracked in TaskNode
      logger.taskEnd(taskName, task_id, runId, result.success, duration, result.error);
      unregisterRun(runId, 'task', taskName);
    })
    .catch((err) => {
      logger.error('Task execution failed', 'task', err, { 
        taskName, 
        taskId: task_id, 
        taskRunId: runId 
      });
      unregisterRun(runId, 'task', taskName);
    });

  res.json({ data: { run_id: runId, status: 'started' } });
}));

// ─── POST /api/task-runs/:id/kill ── abort a running task and all descendants ─
router.post('/:id/kill', handle(async (req, res) => {
  const id = req.params.id as string;
  
  // Check if this run exists and get its details
  const { rows } = await pool.query(
    `SELECT er.id, er.status, er.node_type, er.node_id, t.name as task_name
     FROM execution_runs er
     LEFT JOIN tasks t ON t.id = er.node_id AND er.node_type = 'task'
     WHERE er.id = $1`,
    [id]
  );
  
  if (rows.length === 0) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  
  const run = rows[0];
  
  if (run.status !== 'running') {
    res.status(400).json({ error: `Cannot kill run with status: ${run.status}` });
    return;
  }
  
  // Kill the entire tree
  const { controllersAborted, dbRecordsUpdated } = await killRunTree(id, 'Killed by user');
  
  if (run.task_name) {
    logger.warn(`Task killed by user`, 'task', { 
      taskName: run.task_name, 
      taskId: run.node_id, 
      taskRunId: id,
      killedBy: 'user'
    });
  }
  
  res.json({ 
    data: { 
      killed: true, 
      run_id: id,
      controllers_aborted: controllersAborted,
      db_records_updated: dbRecordsUpdated,
      message: `Killed run ${id} and all descendants`
    } 
  });
}));

// ─── DELETE /api/task-runs/:id ── delete run record ─────────────────────────
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM execution_runs WHERE parent_run_id = $1`, [req.params.id]);
  await pool.query(`DELETE FROM execution_runs WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

export default router;
