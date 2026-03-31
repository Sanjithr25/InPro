import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

import agentsRouter      from './routes/agents.js';
import toolsRouter       from './routes/tools.js';
import tasksRouter       from './routes/tasks.js';
import taskRunsRouter    from './routes/task-runs.js';
import schedulesRouter   from './routes/schedules.js';
import historyRouter     from './routes/history.js';
import llmSettingsRouter from './routes/llm-settings.js';
import fsRouter          from './routes/fs.js';
import dashboardRouter   from './routes/dashboard.js';
import { ToolRegistry }  from './engine/ToolRegistry.js';
import { schedulerService } from './engine/SchedulerService.js';

const app = express();

// ─── Request ID Middleware ────────────────────────────────────────────────────
app.use((req, _res, next) => {
  (req as any).requestId = uuidv4();
  const startTime = Date.now();
  
  logger.apiRequest(req.method, req.path, (req as any).requestId, req.ip);
  
  // Log response
  const originalSend = _res.send;
  _res.send = function(data) {
    const duration = Date.now() - startTime;
    logger.apiResponse(req.method, req.path, (req as any).requestId, _res.statusCode, duration);
    return originalSend.call(this, data);
  };
  
  next();
});

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' }));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/dashboard',     dashboardRouter);
app.use('/api/agents',        agentsRouter);
app.use('/api/tools',         toolsRouter);
app.use('/api/tasks',         tasksRouter);
app.use('/api/task-runs',     taskRunsRouter);
app.use('/api/schedules',     schedulesRouter);
app.use('/api/history',       historyRouter);
app.use('/api/llm-settings',  llmSettingsRouter);
app.use('/api/fs',            fsRouter);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.apiError(req.method, req.path, (req as any).requestId, err.message);
  res.status(500).json({ error: err.message ?? 'Internal server error' });
});

import { reconcileRuns } from './routes/task-runs.js';

// ─── Start ────────────────────────────────────────────────────────────────────
logger.info('Starting API Server', 'system', { 
  nodeVersion: process.version, 
  platform: process.platform,
  env: config.env 
});

Promise.all([
  ToolRegistry.seed(),
  reconcileRuns(),
  schedulerService.start(),
])
  .then(() => {
    app.listen(config.port, () => {
      logger.systemStart(config.port);
      logger.info('LLM Provider Loaded', 'llm', { 
        provider: config.llm.provider, 
        model: config.llm.model,
        isDefault: true 
      });
    });
  })
  .catch(err => {
    logger.error('Startup failed', 'system', err);
    process.exit(1);
  });

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.systemShutdown('SIGTERM received');
  await schedulerService.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.systemShutdown('SIGINT received');
  await schedulerService.stop();
  process.exit(0);
});

export default app;
