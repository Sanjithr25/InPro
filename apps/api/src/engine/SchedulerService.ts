/**
 * SchedulerService — Phase 4 Scheduling Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * - Loads enabled schedules from DB on startup
 * - Computes next_run_at for cron/interval/one_time triggers
 * - Uses BullMQ (Redis-backed) to enqueue schedule jobs when Redis is available
 * - Falls back to in-process setTimeout scheduling when Redis is unavailable
 * - Updates last_run_at, last_run_status, next_run_at after each run
 *
 * SAFETY: Redis is OPTIONAL. The fallback in-process scheduler ensures the app
 * works fully without Redis. BullMQ objects are never constructed until Redis
 * reachability is confirmed via a raw socket probe — this prevents uncaught
 * ECONNREFUSED EventEmitter errors from crashing the process.
 */

import { CronExpressionParser } from 'cron-parser';
import pool from '../db/client.js';
import { TaskNode } from './TaskNode.js';
import type { ExecutionContext } from '../types.js';
import net from 'node:net';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ScheduleRow {
  id: string;
  name: string;
  trigger_type: 'cron' | 'interval' | 'one_time' | 'manual';
  trigger_config: {
    cron?: string;
    intervalMinutes?: number;
    runAt?: string; // ISO string for one_time
  };
  is_enabled: boolean;
  last_run_at: string | null;
  last_run_status: 'completed' | 'failed' | 'running' | null;
  next_run_at: string | null;
  task_ids?: string[];
}

interface ScheduleJobData {
  scheduleId: string;
  taskIds: string[];
}

// ─── Redis reachability probe (raw socket — no IORedis/BullMQ instantiation) ──
function probeRedis(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    try {
      // Parse host + port from redis URL
      const parsed = new URL(url);
      const host = parsed.hostname || '127.0.0.1';
      const port = parseInt(parsed.port || '6379', 10);

      const sock = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, timeoutMs);

      sock.once('connect', () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// ─── Next-run calculator ──────────────────────────────────────────────────────
export function computeNextRun(row: Pick<ScheduleRow, 'trigger_type' | 'trigger_config'>): Date | null {
  const now = new Date();
  try {
    if (row.trigger_type === 'cron' && row.trigger_config.cron) {
      const interval = CronExpressionParser.parse(row.trigger_config.cron, { currentDate: now });
      return interval.next().toDate();
    }
    if (row.trigger_type === 'interval' && row.trigger_config.intervalMinutes) {
      return new Date(now.getTime() + row.trigger_config.intervalMinutes * 60_000);
    }
    if (row.trigger_type === 'one_time' && row.trigger_config.runAt) {
      const t = new Date(row.trigger_config.runAt);
      return t > now ? t : null;
    }
  } catch (e) {
    console.warn('[Scheduler] computeNextRun error:', e);
  }
  return null;
}

// ─── SchedulerService ─────────────────────────────────────────────────────────
export class SchedulerService {
  // BullMQ references — only set when Redis is confirmed reachable
  private queue: import('bullmq').Queue | null = null;
  private worker: import('bullmq').Worker | null = null;
  // Fallback: in-process timers when Redis is unavailable
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private useRedis = false;

  async start() {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

    // ── Step 1: Probe Redis reachability via raw socket BEFORE creating any BullMQ objects.
    // This prevents BullMQ's IORedis from emitting uncaught error events on the process.
    const redisReachable = await probeRedis(redisUrl);

    if (redisReachable) {
      try {
        // Dynamically import BullMQ only when Redis is reachable
        const { Queue, Worker } = await import('bullmq');
        const connection = { url: redisUrl };

        this.queue = new Queue<ScheduleJobData>('schedules', {
          connection,
          defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
        });

        // Attach error listener to prevent uncaught EventEmitter errors
        this.queue.on('error', (err) => {
          console.warn('[Scheduler] BullMQ queue error (non-fatal):', err.message);
        });

        this.useRedis = true;
        console.log('[Scheduler] BullMQ connected to Redis — using queue-backed scheduling');
        this._startWorker(Worker, connection);
      } catch (err) {
        console.warn('[Scheduler] BullMQ init failed — falling back to in-process scheduler:', err);
        this.queue = null;
        this.useRedis = false;
      }
    } else {
      console.warn('[Scheduler] Redis unavailable (connection refused) — using in-process fallback scheduler');
      this.useRedis = false;
    }

    await this._loadAndScheduleAll();
  }

  async stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    try { await this.worker?.close(); } catch { /* ignore */ }
    try { await this.queue?.close(); } catch { /* ignore */ }
  }

  /** Called after create/update/toggle to re-schedule a single schedule */
  async reschedule(scheduleId: string) {
    const { rows } = await pool.query(`
      SELECT s.*, ARRAY_AGG(st.task_id ORDER BY st.order_index) FILTER (WHERE st.task_id IS NOT NULL) AS task_ids
      FROM schedules s
      LEFT JOIN schedule_tasks st ON st.schedule_id = s.id
      WHERE s.id = $1
      GROUP BY s.id
    `, [scheduleId]);

    // If deleted or disabled, ensure we stop any pending runs
    if (rows.length === 0 || !rows[0].is_enabled) {
      this.unschedule(scheduleId);
      return;
    }

    // Clear existing timer if any (redundant but safe as _scheduleOne or unschedule also handle this)
    this.unschedule(scheduleId);
    this._scheduleOne(rows[0]);
  }

  /** Remove a schedule from the timer map (on delete/disable) */
  unschedule(scheduleId: string) {
    const t = this.timers.get(scheduleId);
    if (t) { clearTimeout(t); this.timers.delete(scheduleId); }
    // Also remove from BullMQ queue if pending
    if (this.useRedis && this.queue) {
      this.queue.remove(scheduleId).catch(() => { /* ignore if not found */ });
    }
  }

  // ─── Public execution method (called by manual run route) ──────────────────
  async executeSchedule(scheduleId: string, taskIds: string[]) {
    return this._executeSchedule(scheduleId, taskIds);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _startWorker(
    WorkerClass: typeof import('bullmq').Worker,
    connection: { url: string }
  ) {
    this.worker = new WorkerClass<ScheduleJobData>(
      'schedules',
      async (job) => {
        await this._executeSchedule(job.data.scheduleId, job.data.taskIds);
      },
      { connection, concurrency: 3 }
    );

    this.worker.on('error', (err) => {
      console.warn('[Scheduler] BullMQ worker error (non-fatal):', err.message);
    });
    this.worker.on('failed', (job, err) => {
      console.error(`[Scheduler] Job ${job?.id} failed:`, err.message);
    });
  }

  private async _loadAndScheduleAll() {
    const { rows } = await pool.query(`
      SELECT s.*, ARRAY_AGG(st.task_id ORDER BY st.order_index) FILTER (WHERE st.task_id IS NOT NULL) AS task_ids
      FROM schedules s
      LEFT JOIN schedule_tasks st ON st.schedule_id = s.id
      WHERE s.is_enabled = true
      GROUP BY s.id
    `);
    for (const row of rows) {
      this._scheduleOne(row);
    }
    console.log(`[Scheduler] Loaded ${rows.length} enabled schedule(s)`);
  }

  private _scheduleOne(row: ScheduleRow & { task_ids: string[] }) {
    const next = computeNextRun(row);
    if (!next) return;

    const delayMs = next.getTime() - Date.now();
    if (delayMs < 0) return;

    // Update next_run_at in DB (fire-and-forget)
    pool.query(`UPDATE schedules SET next_run_at = $1 WHERE id = $2`, [next.toISOString(), row.id])
      .catch(e => console.warn('[Scheduler] next_run_at update failed:', e));

    if (this.useRedis && this.queue) {
      // Use the schedule ID as the stable job ID. This ensures that if we reschedule,
      // it replaces (or at least doesn't duplicate) the pending run.
      this.queue.add(
        `schedule:${row.id}`,
        { scheduleId: row.id, taskIds: row.task_ids ?? [] },
        { 
          delay: delayMs,
          jobId: row.id, // Stable ID = only one pending run per schedule
          removeOnComplete: true,
          removeOnFail: true
        }
      ).catch(e => console.warn('[Scheduler] BullMQ enqueue failed (non-fatal):', e));
    } else {
      // In-process fallback
      const timer = setTimeout(() => {
        this.timers.delete(row.id);
        this._executeSchedule(row.id, row.task_ids ?? [])
          .catch(e => console.error('[Scheduler] Execution error:', e));
      }, delayMs);
      this.timers.set(row.id, timer);
    }
  }

  private async _executeSchedule(scheduleId: string, taskIds: string[]) {
    if (taskIds.length === 0) {
      console.warn(`[Scheduler] Schedule ${scheduleId} has no tasks — skipping`);
      return;
    }

    console.log(`[Scheduler] Executing schedule ${scheduleId} with ${taskIds.length} task(s)`);

    // Mark schedule as running
    await pool.query(
      `UPDATE schedules SET last_run_status = 'running', last_run_at = NOW() WHERE id = $1`,
      [scheduleId]
    );

    let overallStatus: 'completed' | 'failed' = 'completed';

    // Create a parent schedule execution_run
    const { rows: runRows } = await pool.query(
      `INSERT INTO execution_runs (node_type, node_id, status, input_data, started_at)
       VALUES ('schedule', $1, 'running', $2, NOW()) RETURNING id`,
      [scheduleId, JSON.stringify({ scheduleId, taskIds })]
    );
    const scheduleRunId = runRows[0].id as string;

    // Run each task in order
    for (const taskId of taskIds) {
      const ctx: ExecutionContext = {
        inputData: { taskId, initialPrompt: '', scheduleId, scheduleRunId },
        currentDepth: 0,
        totalSteps: 0,
        maxDepth: 10,
        parentRunId: scheduleRunId,
      };
      try {
        const result = await new TaskNode().execute(ctx);
        if (!result.success) overallStatus = 'failed';
      } catch (e) {
        console.error(`[Scheduler] Task ${taskId} threw:`, e);
        overallStatus = 'failed';
      }
    }

    // Compute next run for recurring schedules
    const nextRun = await this._getNextRunForSchedule(scheduleId);

    // Update schedule row with final status
    await pool.query(
      `UPDATE schedules SET last_run_status = $1, last_run_at = NOW(), next_run_at = $2 WHERE id = $3`,
      [overallStatus, nextRun?.toISOString() ?? null, scheduleId]
    );

    // Close the schedule execution_run
    await pool.query(
      `UPDATE execution_runs SET status = $1, ended_at = NOW() WHERE id = $2`,
      [overallStatus, scheduleRunId]
    );

    console.log(`[Scheduler] Schedule ${scheduleId} finished with status: ${overallStatus}`);

    // Re-schedule for next run (cron/interval repeat)
    await this.reschedule(scheduleId);
  }

  private async _getNextRunForSchedule(scheduleId: string): Promise<Date | null> {
    const { rows } = await pool.query(
      `SELECT trigger_type, trigger_config FROM schedules WHERE id = $1`,
      [scheduleId]
    );
    if (rows.length === 0) return null;
    return computeNextRun(rows[0]);
  }
}

// Singleton
export const schedulerService = new SchedulerService();
