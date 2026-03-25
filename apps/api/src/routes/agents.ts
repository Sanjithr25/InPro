import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/client.js';
import { AgentNode } from '../engine/AgentNode.js';
import { LLMProviderFactory, type ChatMessage } from '../engine/LLMProviderFactory.js';
import { ToolRegistry } from '../engine/ToolRegistry.js';
import type { ExecutionContext, ToolDefinition } from '../types.js';

const router = Router();

// Helper — wraps async handlers, propagates errors to Express error middleware
const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// ─── GET /api/agents ──────────────────────────────────────────────────────────
router.get('/', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.skill, a.agent_group, a.created_at,
            l.provider AS llm_provider, l.model_name AS provider_model
     FROM agents a
     LEFT JOIN llm_settings l ON a.llm_provider_id = l.id
     ORDER BY a.created_at DESC`
  );
  res.json({ data: rows });
}));

// ─── GET /api/agents/:id ──────────────────────────────────────────────────────
router.get('/:id', handle(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.skill, a.agent_group, a.created_at,
            l.provider AS llm_provider, l.id AS llm_provider_id,
            COALESCE(
              JSON_AGG(JSON_BUILD_OBJECT('id', t.id, 'name', t.name, 'description', t.description))
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

// ─── POST /api/agents/:id/run ─────────────────────────────────────────────────
const DryRunSchema = z.object({ prompt: z.string().min(1) });

router.post('/:id/run', handle(async (req, res) => {
  const parsed = DryRunSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const context: ExecutionContext = {
    inputData: { prompt: parsed.data.prompt, agentId },
    currentDepth: 0,
    totalSteps: 1,
    maxDepth: 5,
    parentRunId: null,
  };

  const agentNode = new AgentNode();
  const result = await agentNode.execute(context);
  res.json({ data: result });
}));

// ─── POST /api/agents/:id/stream (SSE streaming dry run) ─────────────────────
router.post('/:id/stream', async (req: Request, res: Response) => {
  const parsed = DryRunSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const agentId = req.params.id;

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
    // 1. Fetch agent
    const agentRes = await pool.query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
    if (agentRes.rows.length === 0) { send('error', { message: 'Agent not found' }); res.end(); return; }
    const agent = agentRes.rows[0];

    // 2. Fetch tools
    const toolsRes = await pool.query(
      `SELECT t.* FROM tools t JOIN agent_tools at ON t.id = at.tool_id WHERE at.agent_id = $1 AND t.is_enabled = true`,
      [agentId]
    );
    const toolDefs: ToolDefinition[] = toolsRes.rows.map((t: any) => ({
      name: t.name, description: t.description ?? '',
      inputSchema: typeof t.schema === 'string' ? JSON.parse(t.schema) : (t.schema ?? {}),
    }));

    // 3. Resolve LLM provider
    let providerOverride: Parameters<typeof LLMProviderFactory.create>[0] = {};
    const settingsRes = await pool.query(
      agent.llm_provider_id
        ? `SELECT * FROM llm_settings WHERE id = $1`
        : `SELECT * FROM llm_settings WHERE is_default = true LIMIT 1`,
      [agent.llm_provider_id ?? undefined].filter(Boolean)
    );
    if (settingsRes.rows.length > 0) {
      const s = settingsRes.rows[0];
      providerOverride = { provider: s.provider, apiKey: s.api_key, model: s.model_name, baseUrl: s.base_url ?? undefined };
    }

    const llm = LLMProviderFactory.create(providerOverride);

    // 4. Agentic streaming loop
    const messages: ChatMessage[] = [
      { 
        role: 'system', 
        content: `${agent.skill ?? 'You are a helpful AI assistant.'}
        
SYSTEM DIRECTIVE: You have a sandboxed filesystem. 
- Use the provided file tools to manage files. 
- Do NOT prepend 'Documents/' to paths unless explicitly asked; the system handles the root directory for you automatically.
- Your target directory is currently set and enforced by the system.`
      },
      { role: 'user',   content: parsed.data.prompt },
    ];

    send('start', { model: providerOverride.model, provider: providerOverride.provider });

    let fullText = '';
    const usedTools: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    const MAX_TURNS = 10;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      send('turn', { turn: turn + 1 });

      for await (const chunk of llm.chatStream(messages, toolDefs)) {
        if (chunk.type === 'text') {
          fullText += chunk.delta;
          send('text', { delta: chunk.delta });
        } else if (chunk.type === 'tool_call') {
          usedTools.push(chunk.name);
          send('tool_start', { name: chunk.name, arguments: chunk.arguments });
          let toolResult: Record<string, unknown>;
          try {
            toolResult = await ToolRegistry.execute(chunk.name, chunk.arguments, agentId as string);
          } catch (e: any) {
            toolResult = { error: e.message };
          }
          send('tool_result', { name: chunk.name, result: toolResult });
          messages.push({ role: 'assistant', content: fullText });
          messages.push({ role: 'user', content: `Tool "${chunk.name}" result:\n${JSON.stringify(toolResult, null, 2)}` });
          fullText = '';
        } else if (chunk.type === 'done') {
          inputTokens += chunk.inputTokens;
          outputTokens += chunk.outputTokens;
          if (chunk.stopReason !== 'tool_use') {
            send('done', { text: fullText, tools: usedTools, inputTokens, outputTokens });
            res.end();
            return;
          }
        }
      }
    }

    send('done', { text: fullText, tools: usedTools, inputTokens, outputTokens });
  } catch (err: any) {
    send('error', { message: err.message ?? 'Internal error' });
  }
  res.end();
});

export default router;
