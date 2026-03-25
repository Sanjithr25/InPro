import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';

import agentsRouter      from './routes/agents.js';
import toolsRouter       from './routes/tools.js';
import tasksRouter       from './routes/tasks.js';
import llmSettingsRouter from './routes/llm-settings.js';
import { ToolRegistry }  from './engine/ToolRegistry.js';

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/agents',       agentsRouter);
app.use('/api/tools',        toolsRouter);
app.use('/api/tasks',        tasksRouter);
app.use('/api/llm-settings', llmSettingsRouter);
// removed proxy usage

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API Error]', err);
  res.status(500).json({ error: err.message ?? 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
ToolRegistry.seed()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`🚀  API server running on http://localhost:${config.port}`);
      console.log(`    LLM Provider: ${config.llm.provider} / ${config.llm.model}`);
    });
  })
  .catch(err => {
    console.error('[Startup] ToolRegistry.seed() failed:', err);
    process.exit(1);
  });

export default app;
