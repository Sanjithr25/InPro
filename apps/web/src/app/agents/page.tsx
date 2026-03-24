'use client';

import { useEffect, useState, useCallback } from 'react';
import { Bot, Plus, Play, Save, Trash2, ChevronRight, Zap, Clock, Hash } from 'lucide-react';
import { agentsApi, toolsApi, llmApi, type AgentRow, type ToolRow, type LlmSettingRow } from '@/lib/api';

// ─── Initial state ────────────────────────────────────────────────────────────
const blank = (): Partial<AgentRow> & { tool_ids: string[] } => ({
  name: '', skill: '', model_name: '', llm_provider_id: '', tool_ids: [],
});

export default function AgentsPage() {
  const [agents, setAgents]         = useState<AgentRow[]>([]);
  const [tools, setTools]           = useState<ToolRow[]>([]);
  const [providers, setProviders]   = useState<LlmSettingRow[]>([]);
  const [selected, setSelected]     = useState<AgentRow | null>(null);
  const [form, setForm]             = useState(blank());
  const [isNew, setIsNew]           = useState(false);
  const [search, setSearch]         = useState('');

  // Dry run state
  const [prompt, setPrompt]         = useState('');
  const [running, setRunning]       = useState(false);
  const [runResult, setRunResult]   = useState<null | {
    text: string; tokens?: { inputTokens: number; outputTokens: number };
    tools?: string[]; latency?: number; error?: string;
  }>(null);

  const [saving, setSaving]         = useState(false);

  // Load
  const load = useCallback(async () => {
    const [a, t, p] = await Promise.all([agentsApi.list(), toolsApi.list(), llmApi.list()]);
    setAgents(a);
    setTools(t);
    setProviders(p);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = agents.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  // Select an agent for editing
  const select = async (agent: AgentRow) => {
    const full = await agentsApi.get(agent.id);
    setSelected(full);
    setForm({
      name: full.name,
      skill: full.skill,
      model_name: full.model_name,
      llm_provider_id: full.llm_provider_id ?? '',
      tool_ids: (full.tools ?? []).map(t => t.id),
    });
    setIsNew(false);
    setRunResult(null);
  };

  const newAgent = () => {
    setSelected(null);
    setForm(blank());
    setIsNew(true);
    setRunResult(null);
  };

  // Save
  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name ?? '',
        skill: form.skill ?? '',
        model_name: form.model_name ?? '',
        llm_provider_id: form.llm_provider_id || undefined,
        tool_ids: form.tool_ids ?? [],
      };
      if (isNew) {
        const { id } = await agentsApi.create(payload);
        await load();
        const created = await agentsApi.get(id);
        setSelected(created);
        setIsNew(false);
      } else if (selected) {
        await agentsApi.update(selected.id, payload);
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  // Delete
  const del = async () => {
    if (!selected) return;
    if (!confirm(`Delete agent "${selected.name}"?`)) return;
    await agentsApi.delete(selected.id);
    setSelected(null);
    setForm(blank());
    await load();
  };

  // Dry run
  const run = async () => {
    if (!selected || !prompt.trim()) return;
    setRunning(true);
    setRunResult(null);
    try {
      const r = await agentsApi.run(selected.id, prompt);
      setRunResult({
        text: r.error ?? (typeof r.output?.text === 'string'
          ? r.output.text
          : JSON.stringify(r.output, null, 2)),
        tokens: r.tokenUsage,
        tools: r.toolsUsed,
        latency: r.latencyMs,
        error: r.error,
      });
    } catch (e) {
      setRunResult({ text: String(e), error: String(e) });
    } finally {
      setRunning(false);
    }
  };

  const toggleTool = (id: string) =>
    setForm(f => ({
      ...f,
      tool_ids: f.tool_ids?.includes(id)
        ? f.tool_ids.filter(x => x !== id)
        : [...(f.tool_ids ?? []), id],
    }));

  const showForm = isNew || selected !== null;

  return (
    <div className="two-panel">
      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Agents</h2>
          <button className="btn-icon" onClick={newAgent} title="New agent">
            <Plus width={15} height={15} />
          </button>
        </div>

        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search agents…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="list-scroll">
          {filtered.length === 0 && (
            <div className="empty-state">
              <Bot width={32} height={32} />
              <p>No agents yet. <br />Click + to create one.</p>
            </div>
          )}
          {filtered.map(agent => (
            <div
              key={agent.id}
              className={`list-item${selected?.id === agent.id ? ' selected' : ''}`}
              onClick={() => select(agent)}
            >
              <div className="list-item-name">{agent.name}</div>
              <div className="list-item-meta">{agent.llm_provider ?? 'groq'} · {agent.model_name || 'default'}</div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Right panel ───────────────────────────────────────────────────── */}
      <div className="panel-right">
        {!showForm ? (
          <div className="empty-state" style={{ height: '100%' }}>
            <Bot width={48} height={48} />
            <p>Select an agent to edit, or click <strong>+</strong> to create one.</p>
            <button className="btn btn-primary" onClick={newAgent}>
              <Plus width={14} height={14} /> New Agent
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div className="page-title">{isNew ? 'New Agent' : selected?.name}</div>
                <div className="page-subtitle">
                  {isNew ? 'Configure and save your agent' : `ID: ${selected?.id}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!isNew && (
                  <button className="btn btn-danger" onClick={del}>
                    <Trash2 width={14} height={14} /> Delete
                  </button>
                )}
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? <span className="spinner" /> : <Save width={14} height={14} />}
                  {saving ? 'Saving…' : 'Save Agent'}
                </button>
              </div>
            </div>

            {/* Name */}
            <div className="card">
              <div className="card-title"><Bot width={16} height={16} /> Identity</div>
              <div className="form-group">
                <label className="form-label">Agent Name</label>
                <input
                  className="form-input"
                  placeholder="e.g. Research Analyst"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>

              {/* LLM Provider */}
              <div className="form-group">
                <label className="form-label">LLM Provider</label>
                <select
                  className="form-select"
                  value={form.llm_provider_id}
                  onChange={e => setForm(f => ({ ...f, llm_provider_id: e.target.value }))}
                >
                  <option value="">Use system default</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.provider} — {p.model_name}{p.is_default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Model Override <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                <input
                  className="form-input"
                  placeholder="Leave blank to use provider default"
                  value={form.model_name}
                  onChange={e => setForm(f => ({ ...f, model_name: e.target.value }))}
                />
              </div>
            </div>

            {/* Skill */}
            <div className="card">
              <div className="card-title"><ChevronRight width={16} height={16} /> Skill (System Prompt)</div>
              <div className="form-group">
                <label className="form-label">Paste or type your agent's skill / system prompt</label>
                <textarea
                  className="form-textarea"
                  rows={8}
                  placeholder="You are a helpful AI assistant that specializes in…"
                  value={form.skill}
                  onChange={e => setForm(f => ({ ...f, skill: e.target.value }))}
                />
              </div>
              {form.skill && (
                <div className="md-preview" style={{ marginTop: 8, fontSize: 12 }}>
                  Preview: {form.skill.slice(0, 200)}{form.skill.length > 200 ? '…' : ''}
                </div>
              )}
            </div>

            {/* Tools */}
            <div className="card">
              <div className="card-title"><Zap width={16} height={16} /> Available Tools</div>
              {tools.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tools registered yet. <a href="/tools" style={{ color: 'var(--accent-hover)' }}>Add tools →</a></p>
              ) : (
                <div className="tool-chips">
                  {tools.map(t => (
                    <div
                      key={t.id}
                      className={`tool-chip${form.tool_ids?.includes(t.id) ? ' selected' : ''}`}
                      onClick={() => toggleTool(t.id)}
                    >
                      {t.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Dry Run — only when agent is saved */}
            {!isNew && selected && (
              <div className="card">
                <div className="card-title"><Play width={16} height={16} /> Dry Run</div>
                <div className="form-group">
                  <label className="form-label">Sample Prompt</label>
                  <textarea
                    className="form-textarea"
                    rows={3}
                    placeholder="Type a test prompt for this agent…"
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={run}
                  disabled={running || !prompt.trim()}
                >
                  {running ? <span className="spinner" /> : <Play width={13} height={13} />}
                  {running ? 'Running…' : 'Execute'}
                </button>

                {runResult && (
                  <div style={{ marginTop: 20 }}>
                    <div className={`output-panel${runResult.error ? ' ' : ''}`}
                      style={{ borderColor: runResult.error ? 'rgba(239,68,68,0.4)' : undefined }}>
                      {runResult.text}
                    </div>
                    <div className="output-meta">
                      {runResult.tokens && (
                        <>
                          <span><Hash width={11} height={11} /> {runResult.tokens.inputTokens} in</span>
                          <span><Hash width={11} height={11} /> {runResult.tokens.outputTokens} out</span>
                        </>
                      )}
                      {runResult.latency && (
                        <span><Clock width={11} height={11} /> {runResult.latency}ms</span>
                      )}
                      {(runResult.tools ?? []).length > 0 && (
                        <span><Zap width={11} height={11} /> {runResult.tools!.join(', ')}</span>
                      )}
                      {runResult.error && (
                        <span style={{ color: 'var(--red)' }}>Error: {runResult.error}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
