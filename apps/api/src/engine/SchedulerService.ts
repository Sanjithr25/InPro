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
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

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

    const redisReachable = await probeRedis(redisUrl);

    if (redisReachable) {
      try {
        const { Queue, Worker } = await import('bullmq');
        const connection = { url: redisUrl };

        this.queue = new Queue<ScheduleJobData>('schedules', {
          connection,
          defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
        });

        this.queue.on('error', (err) => {
          logger.warn('BullMQ queue error (non-fatal)', 'redis', { error: err.message });
        });

        this.useRedis = true;
        logger.redisConnected('bullmq');
        this._startWorker(Worker, connection);
      } catch (err: any) {
        logger.redisError(err.message);
        this.queue = null;
        this.useRedis = false;
      }
    } else {
      logger.redisError('Connection refused');
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

  /** Public method to execute a schedule (used by manual trigger and scheduled runs) */
  async executeSchedule(scheduleId: string, taskIds: string[]) {
    return this._executeSchedule(scheduleId, taskIds);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _startWorker(
    WorkerClass: typeof import('bullmq').Worker,
    connection: { url: string }
  ) {
    // BullMQ requires maxRetriesPerRequest to be null
    const connectionOptions = {
      ...connection,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 1000, 4000);
      },
    };
    
    this.worker = new WorkerClass<ScheduleJobData>(
      'schedules',
      async (job) => {
        await this._executeSchedule(job.data.scheduleId, job.data.taskIds);
      },
      { 
        connection: connectionOptions, 
        concurrency: 3,
      }
    );

    this.worker.on('error', (err) => {
      logger.warn('BullMQ worker error (non-fatal)', 'redis', { error: err.message });
    });
    this.worker.on('failed', (job, err) => {
      logger.error('BullMQ job failed', 'scheduler', err, { 
        metadata: { jobId: job?.id }
      });
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
    
    const { rows: totalRows } = await pool.query(`SELECT COUNT(*) as total FROM schedules`);
    const totalCount = parseInt(totalRows[0].total);
    
    logger.schedulerInit(rows.length, totalCount);
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
      logger.warn('Schedule has no tasks, skipping execution', 'scheduler', { scheduleId });
      return;
    }

    const { rows: schedRows } = await pool.query(`SELECT name FROM schedules WHERE id = $1`, [scheduleId]);
    const scheduleName = schedRows[0]?.name || 'Unknown Schedule';

    await pool.query(
      `UPDATE schedules SET last_run_status = 'running', last_run_at = NOW() WHERE id = $1`,
      [scheduleId]
    );

    let overallStatus: 'completed' | 'failed' = 'completed';
    const scheduleRunId = uuidv4();
    const traceId = uuidv4();
    const startTime = Date.now();
    
    const scheduleController = new AbortController();
    const { registerRun, unregisterRun } = await import('../routes/task-runs.js');
    
    registerRun(scheduleRunId, scheduleController, 'schedule', scheduleName);
    
    try {
      await pool.query(
        `INSERT INTO execution_runs (id, node_type, node_id, status, input_data, started_at)
         VALUES ($1, 'schedule', $2, 'running', $3, NOW())`,
        [scheduleRunId, scheduleId, JSON.stringify({ scheduleId, taskIds })]
      );

      logger.scheduleStart(scheduleName, scheduleId, scheduleRunId, taskIds.length, traceId);

      const { rows: taskRows } = await pool.query(
        `SELECT id, name FROM tasks WHERE id = ANY($1::uuid[])`,
        [taskIds]
      );
      const taskMap = new Map(taskRows.map((t: any) => [t.id, t.name]));

      for (let i = 0; i < taskIds.length; i++) {
        const taskId = taskIds[i];
        const taskName = taskMap.get(taskId) || 'Unknown Task';
        
        if (scheduleController.signal.aborted) {
          logger.warn(`Schedule aborted, stopping task execution (${i + 1}/${taskIds.length} tasks completed)`, 'scheduler', {
            scheduleName,
            scheduleId,
            scheduleRunId,
          });
          overallStatus = 'failed';
          break;
        }
        
        const taskController = new AbortController();
        const taskRunId = uuidv4();
        const taskStartTime = Date.now();
        
        registerRun(taskRunId, taskController, 'task', taskName);
        
        scheduleController.signal.addEventListener('abort', () => {
          taskController.abort();
        });
        
        const ctx: ExecutionContext = {
          inputData: { taskId, initialPrompt: '', scheduleId, scheduleRunId, runId: taskRunId },
          currentDepth: 0,
          totalSteps: 0,
          maxDepth: 10,
          parentRunId: scheduleRunId,
          abortSignal: taskController.signal,
        };
        
        logger.taskStart(taskName, taskId, taskRunId, scheduleRunId);
        
        try {
          const result = await new TaskNode().execute(ctx);
          const taskDuration = Date.now() - taskStartTime;
          
          // Check if schedule was killed while task was running
          const { rows: scheduleCheck } = await pool.query(
            `SELECT status FROM execution_runs WHERE id = $1`,
            [scheduleRunId]
          );
          
          if (scheduleCheck[0]?.status === 'failed') {
            logger.warn('Schedule was killed externally, stopping execution', 'scheduler', {
              scheduleName,
              scheduleId,
              scheduleRunId,
            });
            scheduleController.abort();
            overallStatus = 'failed';
            logger.taskEnd(taskName, taskId, taskRunId, false, taskDuration, 'Schedule killed');
            break;
          }
          
          if (!result.success) {
            overallStatus = 'failed';
            logger.taskEnd(taskName, taskId, taskRunId, false, taskDuration, result.error);
          } else {
            logger.taskEnd(taskName, taskId, taskRunId, true, taskDuration);
          }
        } catch (e: any) {
          const taskDuration = Date.now() - taskStartTime;
          logger.error('Task execution threw exception', 'task', e, {
            taskName,
            taskId,
            taskRunId,
            scheduleName,
            scheduleId,
            scheduleRunId,
          });
          overallStatus = 'failed';
          
          if (e.name === 'AbortError' || scheduleController.signal.aborted) {
            logger.taskEnd(taskName, taskId, taskRunId, false, taskDuration, 'Aborted');
            break;
          }
        } finally {
          unregisterRun(taskRunId, 'task', taskName);
        }
      }

      if (scheduleController.signal.aborted) {
        overallStatus = 'failed';
      }

      const nextRun = await this._getNextRunForSchedule(scheduleId);

      await pool.query(
        `UPDATE schedules SET last_run_status = $1, last_run_at = NOW(), next_run_at = $2 WHERE id = $3`,
        [overallStatus, nextRun?.toISOString() ?? null, scheduleId]
      );

      await pool.query(
        `UPDATE execution_runs SET status = $1, ended_at = NOW() WHERE id = $2`,
        [overallStatus, scheduleRunId]
      );

      const scheduleDuration = Date.now() - startTime;
      logger.scheduleEnd(scheduleName, scheduleId, scheduleRunId, overallStatus === 'completed', scheduleDuration);

      await this.reschedule(scheduleId);
      
    } finally {
      unregisterRun(scheduleRunId, 'schedule', scheduleName);
    }
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
