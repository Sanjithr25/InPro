import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { executeAgent } from '../engine/agent/executeAgent.js';
import { LLMProviderFactory, type ChatMessage } from '../engine/LLMProviderFactory.js';
import { ToolRegistry } from '../engine/ToolRegistry.js';
import { logger } from '../utils/logger.js';
import type { ToolDefinition } from '../types.js';

const router = Router();

// Helper — wraps async handlers, propagates errors to Express error middleware
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// ─── GET /api/agents ──────────────────────────────────────────────────────────
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.skill, a.agent_group, a.created_at, a.updated_at,
            l.provider AS llm_provider, l.model_name AS provider_model
     FROM agents a
     LEFT JOIN llm_settings l ON a.llm_provider_id = l.id
     ORDER BY a.created_at DESC`
  );
  res.json({ data: rows });
}));

// ─── GET /api/agents/groups ───────────────────────────────────────────────────
router.get('/groups/list', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT agent_group 
     FROM agents 
     WHERE agent_group IS NOT NULL AND agent_group != '' 
     ORDER BY agent_group ASC`
  );
  const groups = rows.map(r => r.agent_group);
  res.json({ data: groups });
}));

// ─── GET /api/agents/:id ──────────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.skill, a.agent_group, a.created_at, a.updated_at,
            l.provider AS llm_provider, l.id AS llm_provider_id,
            COALESCE(
              JSON_AGG(JSON_BUILD_OBJECT(
                'id', t.id, 
                'name', t.name, 
                'description', t.description,
                'risk_level', t.risk_level,
                'schema', t.schema
              ))
              FILTER (WHERE t.id IS NOT NULL), '[]'
            ) AS tools
     FROM agents a
     LEFT JOIN llm_settings l ON a.llm_provider_id = l.id
     LEFT JOIN agent_tools at2 ON a.id = at2.agent_id
     LEFT JOIN tools t ON at2.tool_id = t.id
     WHERE a.id = $1
     GROUP BY a.id, l.provider, l.id`,
    [req.params.id]
  );
  if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json({ data: rows[0] });
}));

// ─── POST /api/agents/auto-categorize ────────────────────────────────────────
const AutoCategorizeSchema = z.object({
  name: z.string().min(1),
  skill: z.string().default(''),
});

router.post('/auto-categorize', handle(async (req, res) => {
  const parsed = AutoCategorizeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { name, skill } = parsed.data;

  // Get existing groups
  const { rows: groupRows } = await pool.query(
    `SELECT DISTINCT agent_group 
     FROM agents 
     WHERE agent_group IS NOT NULL AND agent_group != '' 
     ORDER BY agent_group ASC`
  );
  const existingGroups = groupRows.map(r => r.agent_group);

  // Get default LLM provider
  const { rows: llmRows } = await pool.query(
    `SELECT * FROM llm_settings WHERE is_default = true LIMIT 1`
  );
  
  if (llmRows.length === 0) {
    res.status(400).json({ error: 'No default LLM provider configured' });
    return;
  }

  const llmSettings = llmRows[0];
  const llm = LLMProviderFactory.create({
    provider: llmSettings.provider,
    apiKey: llmSettings.api_key,
    model: llmSettings.model_name,
    baseUrl: llmSettings.base_url ?? undefined,
  });

  // Build categorization prompt
  const prompt = `You are an AI agent categorization system. Your task is to assign an agent to the most appropriate group based on its name and skill description.

Agent Name: ${name}
Agent Skill/Description: ${skill || 'No description provided'}

${existingGroups.length > 0 ? `Existing Groups: ${existingGroups.join(', ')}` : 'No existing groups yet.'}

Instructions:
1. If the agent fits well into an existing group, return that group name EXACTLY as shown above
2. If the agent doesn't fit any existing group, create a NEW group name that is:
   - Short (1-2 words)
   - Descriptive of the agent's primary function
   - Professional and clear
   - Examples: "Research", "Finance", "Support", "Content", "Analytics", "Development"

Return ONLY the group name, nothing else. No explanation, no punctuation, just the group name.`;

  // Inject current date for temporal context
  const currentDate = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const systemPrompt = `Current date: ${currentDate}. Always use this as reference for time-sensitive queries.`;

  try {
    let suggestedGroup = '';
    
    // Stream the response to get the group name
    for await (const chunk of llm.chatStream([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ], [])) {
      if (chunk.type === 'text') {
        suggestedGroup += chunk.delta;
      }
    }

    // Clean up the response
    suggestedGroup = suggestedGroup.trim().replace(/['"]/g, '');
    
    // Validate it's not empty
    if (!suggestedGroup) {
      suggestedGroup = 'General';
    }

    res.json({ data: { group: suggestedGroup } });
  } catch (err: any) {
    res.status(500).json({ error: `Auto-categorization failed: ${err.message}` });
  }
}));

// ─── POST /api/agents ─────────────────────────────────────────────────────────
const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  skill: z.string().default(''),
  llm_provider_id: z.string().uuid().optional(),
  agent_group: z.string().default(''),
  tool_ids: z.array(z.string().uuid()).default([]),
});

router.post('/', handle(async (req, res) => {
  const parsed = CreateAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { name, skill, llm_provider_id, agent_group, tool_ids } = parsed.data;
  const id = uuidv4();

  await pool.query(
    `INSERT INTO agents (id, name, skill, llm_provider_id, agent_group)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name, skill, llm_provider_id ?? null, agent_group]
  );

  if (tool_ids.length > 0) {
    const values = tool_ids.map((_tid, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const params = tool_ids.flatMap((tid) => [id, tid]);
    await pool.query(`INSERT INTO agent_tools (agent_id, tool_id) VALUES ${values}`, params);
  }

  res.status(201).json({ data: { id } });
}));

// ─── PUT /api/agents/:id ──────────────────────────────────────────────────────
const UpdateAgentSchema = CreateAgentSchema.partial();

router.put('/:id', handle(async (req, res) => {
  const parsed = UpdateAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { tool_ids, ...fields } = parsed.data;
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) {
      updates.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }

  if (updates.length > 0) {
    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);
    await pool.query(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${idx}`, values);
  }

  if (tool_ids !== undefined) {
    await pool.query(`DELETE FROM agent_tools WHERE agent_id = $1`, [req.params.id]);
    if (tool_ids.length > 0) {
      const vals = tool_ids.map((_tid, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
      const params = tool_ids.flatMap((tid) => [req.params.id, tid]);
      await pool.query(`INSERT INTO agent_tools (agent_id, tool_id) VALUES ${vals}`, params);
    }
  }

  res.json({ data: { updated: true } });
}));

// ─── DELETE /api/agents/:id ───────────────────────────────────────────────────
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM agents WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

// ─── POST /api/agents/:id/dry-run ────────────────────────────────────────────
import { SystemConfig } from '../config/system.js';

const DryRunSchema = z.object({ prompt: z.string().min(1) });

router.post('/:id/dry-run', handle(async (req, res) => {
  const parsed = DryRunSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  // Step 1: Enforce single active dry run globally
  const { rows: activeRows } = await pool.query(`
    SELECT COUNT(*) as count 
    FROM execution_runs 
    WHERE is_dry_run = true AND status = 'running'
  `);
  
  if (parseInt(activeRows[0].count, 10) > 0) {
    res.status(409).json({ 
      error: 'Another dry run is currently in progress. Please wait for it to complete.' 
    });
    return;
  }

  // Step 2: Generate runId
  const runId = uuidv4();

  // Step 3: Execute via executeAgent (creates run record internally)
  executeAgent({
    agentId,
    prompt: parsed.data.prompt,
    runId,
    isDryRun: true,
    mode: 'sync',
  }).then(async (result) => {
    logger.info(`Execution completed for runId: ${runId}, agentId: ${agentId}`, 'agent', { isDryRun: true, runId });
    logger.debug(`Result: ${JSON.stringify(result, null, 2)}`, 'agent', { isDryRun: true });
  }).catch((err) => {
    logger.error('Dry run execution error', 'agent', err, { agentId });
  });

  // Step 4: Return immediately with runId
  res.json({ data: { runId, status: 'running' } });
}));

// ─── GET /api/agents/:id/dry-runs ─────────────────────────────────────────────
router.get('/:id/dry-runs', handle(async (req, res) => {
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  
  const { rows } = await pool.query(`
    SELECT 
      id, status, input_data, output_data, error_message,
      started_at, ended_at,
      EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))::int AS duration_seconds
    FROM execution_runs
    WHERE node_type = 'agent'
      AND node_id = $1
      AND is_dry_run = true
    ORDER BY started_at DESC
    LIMIT 10
  `, [agentId]);
  
  res.json({ data: rows });
}));

// ─── GET /api/agents/:id/dry-runs/latest ──────────────────────────────────────
router.get('/:id/dry-runs/latest', handle(async (req, res) => {
  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  
  const { rows } = await pool.query(`
    SELECT 
      id, status, input_data, output_data, error_message,
      started_at, ended_at,
      EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))::int AS duration_seconds
    FROM execution_runs
    WHERE node_type = 'agent'
      AND node_id = $1
      AND is_dry_run = true
    ORDER BY started_at DESC
    LIMIT 1
  `, [agentId]);
  
  if (rows.length === 0) {
    // Return null data instead of 404 - this is expected for agents without dry runs
    res.json({ data: null });
    return;
  }
  
  res.json({ data: rows[0] });
}));

// ─── DELETE /api/agents/:id ───────────────────────────────────────────────────
router.delete('/:id', handle(async (req, res) => {
  await pool.query(`DELETE FROM agents WHERE id = $1`, [req.params.id]);
  res.json({ data: { deleted: true } });
}));

// ─── POST /api/agents/:id/run ─────────────────────────────────────────────────
const RunSchema = z.object({ prompt: z.string().min(1) });

router.post('/:id/run', handle(async (req, res) => {
  const parsed = RunSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const result = await executeAgent({
    agentId,
    prompt: parsed.data.prompt,
    mode: 'sync',
  });

  res.json({ data: result });
}));

// ─── POST /api/agents/:id/stream (SSE streaming dry run) ─────────────────────
router.post('/:id/stream', async (req: Request, res: Response) => {
  const parsed = DryRunSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  // ── SSE headers ──────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Generate runId
    const runId = uuidv4();
    
    send('start', { runId });

    // Execute with streaming callback
    await executeAgent({
      agentId,
      prompt: parsed.data.prompt,
      runId,
      isDryRun: true,
      mode: 'stream',
      onStream: (event) => {
        switch (event.type) {
          case 'validation':
            send('validation', event.data);
            break;
          case 'start':
            send('agent_start', event.data);
            break;
          case 'turn':
            send('turn', event.data);
            break;
          case 'text':
            send('text', event.data);
            break;
          case 'tool_start':
            send('tool_start', event.data);
            break;
          case 'tool_result':
            send('tool_result', event.data);
            break;
          case 'done':
            send('done', event.data);
            break;
          case 'error':
            send('error', event.data);
            break;
        }
      }
    });

  } catch (err: any) {
    send('error', { message: err.message ?? 'Internal error' });
  }
  res.end();
});

export default router;
