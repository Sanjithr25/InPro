'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Bot, Plus, Play, Save, Trash2, ChevronRight, Zap, Clock, Hash, Upload, X } from 'lucide-react';
import { agentsApi, toolsApi, llmApi, type AgentRow, type ToolRow, type LlmSettingRow } from '@/lib/api';

// ─── Initial state ────────────────────────────────────────────────────────────
const blank = (): Partial<AgentRow> & { tool_ids: string[] } => ({
  name: '', skill: '', agent_group: '', llm_provider_id: '', tool_ids: [],
});

export default function AgentsPage() {
  const [agents, setAgents]       = useState<AgentRow[]>([]);
  const [tools, setTools]         = useState<ToolRow[]>([]);
  const [providers, setProviders] = useState<LlmSettingRow[]>([]);
  const [selected, setSelected]   = useState<AgentRow | null>(null);
  const [form, setForm]           = useState(blank());
  const [isNew, setIsNew]         = useState(false);
  const [search, setSearch]       = useState('');
  const [saving, setSaving]       = useState(false);
  const fileInputRef              = useRef<HTMLInputElement>(null);

  // Dry run state
  const [prompt, setPrompt]         = useState('');
  const [running, setRunning]       = useState(false);
  const [streamText, setStreamText] = useState('');
  const [runMeta, setRunMeta]       = useState<null | {
    tokens?: { inputTokens: number; outputTokens: number };
    tools?: string[]; error?: string;
    provider?: string; model?: string;
  }>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Load everything
  const load = useCallback(async () => {
    const [a, t, p] = await Promise.all([agentsApi.list(), toolsApi.list(), llmApi.list()]);
    setAgents(a);
    setTools(t);
    setProviders(p);
  }, []);

  useEffect(() => { load(); }, [load]);

  const defaultProvider = providers.find(p => p.is_default);

  const filtered = agents.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.agent_group ?? '').toLowerCase().includes(search.toLowerCase())
  );

  // Group agents by agent_group for the sidebar
  const grouped = filtered.reduce<Record<string, AgentRow[]>>((acc, a) => {
    const g = a.agent_group?.trim() || 'Ungrouped';
    if (!acc[g]) acc[g] = [];
    acc[g].push(a);
    return acc;
  }, {});

  const select = async (agent: AgentRow) => {
    const full = await agentsApi.get(agent.id);
    setSelected(full);
    setForm({
      name: full.name,
      skill: full.skill,
      agent_group: full.agent_group ?? '',
      llm_provider_id: full.llm_provider_id ?? '',
      tool_ids: (full.tools ?? []).map(t => t.id),
    });
    setIsNew(false);
    setStreamText('');
    setRunMeta(null);
  };

  const newAgent = () => {
    setSelected(null);
    setForm(blank());
    setIsNew(true);
    setStreamText('');
    setRunMeta(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name ?? '',
        skill: form.skill ?? '',
        agent_group: form.agent_group ?? '',
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

  const del = async () => {
    if (!selected) return;
    if (!confirm(`Delete agent "${selected.name}"?`)) return;
    await agentsApi.delete(selected.id);
    setSelected(null);
    setForm(blank());
    await load();
  };

  const run = async () => {
    if (!selected || !prompt.trim()) return;
    setRunning(true);
    setStreamText('');
    setRunMeta(null);

    const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    try {
      const resp = await fetch(`${API}/api/agents/${selected.id}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const parseLine = (line: string) => {
        if (!line.startsWith('data:')) return;
        try {
          const payload = JSON.parse(line.slice(5).trim());
          return payload;
        } catch { return null; }
      };

      let currentEvent = '';
      let startMeta: { provider?: string; model?: string } = {};
      let toolLog: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const payload = parseLine(line);
            if (!payload) continue;
            if (currentEvent === 'start') {
              startMeta = { provider: payload.provider, model: payload.model };
            } else if (currentEvent === 'text') {
              setStreamText(t => t + payload.delta);
              // Auto-scroll
              setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);
            } else if (currentEvent === 'tool_start') {
              toolLog.push(payload.name);
              setStreamText(t => t + `\n[🔧 calling ${payload.name}...]\n`);
            } else if (currentEvent === 'tool_result') {
              setStreamText(t => t + `[✓ ${payload.name} done]\n`);
            } else if (currentEvent === 'done') {
              setRunMeta({
                tokens: payload.inputTokens != null ? { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens } : undefined,
                tools: payload.tools,
                ...startMeta,
              });
            } else if (currentEvent === 'error') {
              setRunMeta({ error: payload.message, ...startMeta });
            }
          }
        }
      }
    } catch (e: any) {
      setRunMeta({ error: String(e) });
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

  // Upload .md file handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      setForm(f => ({ ...f, skill: text }));
    };
    reader.readAsText(file);
    // reset so same file can be re-selected
    e.target.value = '';
  };

  const showForm = isNew || selected !== null;

  // Resolve display label for active provider
  const activeProvider = providers.find(p => p.id === form.llm_provider_id);
  const providerLabel = activeProvider
    ? `${activeProvider.provider} — ${activeProvider.model_name}`
    : defaultProvider
      ? `${defaultProvider.provider} — ${defaultProvider.model_name} (default)`
      : 'System default';

  // Group tools for selection UI
  const groupedTools: { title: string; items: ToolRow[] }[] = [
    { title: 'File System', items: [] },
    { title: 'Built-in Utils', items: [] },
    { title: 'Custom Extensions', items: [] },
  ];
  const fsNames = ['read_file', 'write_file', 'delete_file', 'list_directory', 'find_files', 'search_files'];
  for (const t of tools) {
    if (fsNames.includes(t.name)) groupedTools[0].items.push(t);
    else if (t.is_builtin)        groupedTools[1].items.push(t);
    else                          groupedTools[2].items.push(t);
  }

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
            placeholder="Search agents or groups…"
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
          {Object.entries(grouped).map(([group, groupAgents]) => (
            <div key={group}>
              {/* Group header — only shown when there are multiple groups or a named group */}
              {(Object.keys(grouped).length > 1 || group !== 'Ungrouped') && (
                <div style={{
                  padding: '6px 14px 4px',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  userSelect: 'none',
                }}>
                  {group}
                </div>
              )}
              {groupAgents.map(agent => (
                <div
                  key={agent.id}
                  className={`list-item${selected?.id === agent.id ? ' selected' : ''}`}
                  onClick={() => select(agent)}
                >
                  <div className="list-item-name">{agent.name}</div>
                  <div className="list-item-meta">
                    {agent.llm_provider ?? defaultProvider?.provider ?? 'llama-local'} · {agent.provider_model ?? defaultProvider?.model_name ?? 'llama3.2'}
                  </div>
                </div>
              ))}
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
            {/* Header */}
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

            {/* ── Identity card ───────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Bot width={16} height={16} /> Identity</div>

              <div className="form-group">
                <label className="form-label">Agent Name</label>
                <input
                  id="agent-name"
                  className="form-input"
                  placeholder="e.g. Research Analyst"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Group <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional — groups agents in the sidebar)</span></label>
                <input
                  id="agent-group"
                  className="form-input"
                  placeholder="e.g. Finance, Research, Support…"
                  value={form.agent_group}
                  onChange={e => setForm(f => ({ ...f, agent_group: e.target.value }))}
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">LLM Provider</label>
                <select
                  id="agent-llm-provider"
                  className="form-select"
                  value={form.llm_provider_id}
                  onChange={e => setForm(f => ({ ...f, llm_provider_id: e.target.value }))}
                >
                  <option value="">
                    {defaultProvider
                      ? `Default — ${defaultProvider.provider} / ${defaultProvider.model_name}`
                      : 'Use system default'}
                  </option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.provider} — {p.model_name}{p.is_default ? ' ✓ default' : ''}
                    </option>
                  ))}
                </select>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                  Active: <strong style={{ color: 'var(--text-secondary)' }}>{providerLabel}</strong>
                </div>
              </div>
            </div>

            {/* ── Skill card ──────────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><ChevronRight width={16} height={16} /> Skill / System Prompt</div>

              {/* Upload or type toggle */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: '5px 12px' }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload width={13} height={13} /> Upload .md file
                </button>
                {form.skill && (
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, padding: '5px 10px', color: 'var(--red)' }}
                    onClick={() => setForm(f => ({ ...f, skill: '' }))}
                    title="Clear skill"
                  >
                    <X width={13} height={13} /> Clear
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Skill description</label>
                <textarea
                  id="agent-skill"
                  className="form-textarea"
                  rows={10}
                  placeholder={"You are a helpful AI assistant that specializes in…\n\nDescribe the agent's role, capabilities, tone, and any constraints."}
                  value={form.skill}
                  onChange={e => setForm(f => ({ ...f, skill: e.target.value }))}
                />
              </div>
            </div>

            {/* ── Tools card ──────────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Zap width={16} height={16} /> Available Tools</div>
              {tools.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tools registered yet. <a href="/tools" style={{ color: 'var(--accent-hover)' }}>Add tools →</a></p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {groupedTools.map(g => g.items.length > 0 && (
                    <div key={g.title}>
                      <div style={{
                        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.05em', color: 'var(--text-muted)',
                        marginBottom: 8
                      }}>
                        {g.title}
                      </div>
                      <div className="tool-chips">
                        {g.items.map(t => (
                          <div
                            key={t.id}
                            className={`tool-chip${form.tool_ids?.includes(t.id) ? ' selected' : ''}`}
                            onClick={() => toggleTool(t.id)}
                            title={t.description}
                          >
                            {t.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Dry Run — only when agent is saved ──────────────────────── */}
            {!isNew && selected && (
              <div className="card">
                <div className="card-title"><Play width={16} height={16} /> Dry Run</div>
                <div className="form-group">
                  <label className="form-label">Sample Prompt</label>
                  <textarea
                    id="agent-dry-run-prompt"
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
                  {running ? 'Streaming…' : 'Execute'}
                </button>

                {(streamText || runMeta) && (
                  <div style={{ marginTop: 20 }}>
                    <div
                      ref={outputRef}
                      className="output-panel"
                      style={{
                        whiteSpace: 'pre-wrap',
                        maxHeight: 360,
                        overflowY: 'auto',
                        borderColor: runMeta?.error ? 'rgba(239,68,68,0.4)' : undefined,
                        fontFamily: 'monospace',
                        fontSize: 13,
                        lineHeight: 1.6,
                      }}
                    >
                      {streamText || ' '}
                      {running && <span style={{ opacity: 0.5, animation: 'pulse 1s infinite' }}>▍</span>}
                    </div>
                    {runMeta && (
                      <div className="output-meta">
                        {runMeta.model && <span>🤖 {runMeta.provider} / {runMeta.model}</span>}
                        {runMeta.tokens && (
                          <>
                            <span><Hash width={11} height={11} /> {runMeta.tokens.inputTokens} in</span>
                            <span><Hash width={11} height={11} /> {runMeta.tokens.outputTokens} out</span>
                          </>
                        )}
                        {(runMeta.tools ?? []).length > 0 && (
                          <span><Zap width={11} height={11} /> {runMeta.tools!.join(', ')}</span>
                        )}
                        {runMeta.error && (
                          <span style={{ color: 'var(--red)' }}>Error: {runMeta.error}</span>
                        )}
                      </div>
                    )}
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
