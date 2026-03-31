'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Bot, Plus, Play, Save, Trash2, ChevronRight, ChevronDown, Zap, Clock, Hash, Upload, X, Settings, Timer, Thermometer } from 'lucide-react';
import { agentsApi, toolsApi, llmApi, type AgentRow, type ToolRow, type LlmSettingRow } from '@/lib/api';

// ─── Utility: Relative Time ──────────────────────────────────────────────────
function getRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

// ─── Initial state ────────────────────────────────────────────────────────────
const blank = (): Partial<AgentRow> & { tool_ids: string[] } => ({
  name: '', skill: '', agent_group: '', llm_provider_id: '', tool_ids: [],
  max_turns: undefined, timeout_ms: undefined, temperature: undefined,
});

export default function AgentsPage() {
  const [agents, setAgents]       = useState<AgentRow[]>([]);
  const [tools, setTools]         = useState<ToolRow[]>([]);
  const [providers, setProviders] = useState<LlmSettingRow[]>([]);
  const [groups, setGroups]       = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selected, setSelected]   = useState<AgentRow | null>(null);
  const [form, setForm]           = useState(blank());
  const [isNew, setIsNew]         = useState(false);
  const [search, setSearch]       = useState('');
  const [saving, setSaving]       = useState(false);
  const [autoCategorizingGroup, setAutoCategorizingGroup] = useState(false);
  const fileInputRef              = useRef<HTMLInputElement>(null);

  // Dry run state - simple and clean
  const [dryRunPrompt, setDryRunPrompt] = useState('');
  const [dryRunning, setDryRunning] = useState(false);
  const [latestDryRun, setLatestDryRun] = useState<{
    id: string;
    status: string;
    output: any;
    error: string | null;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
    input_data?: any;
  } | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Load latest dry run for selected agent
  const loadLatestDryRun = useCallback(async (agentId: string) => {
    try {
      const response = await fetch(`http://localhost:3001/api/agents/${agentId}/dry-runs/latest`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const { data } = await response.json();
      
      // Handle null data (no dry runs yet)
      if (!data) {
        setLatestDryRun(null);
        return null;
      }
      
      // Extract the actual output - it's nested as output_data.output
      const actualOutput = data.output_data?.output || data.output_data;
      
      const dryRun = {
        id: data.id,
        status: data.status,
        output: actualOutput,
        error: data.error_message,
        started_at: data.started_at,
        ended_at: data.ended_at,
        duration_seconds: data.duration_seconds,
        input_data: data.input_data,
      };
      
      setLatestDryRun(dryRun);
      
      // If running, start polling
      if (data.status === 'running') {
        setDryRunning(true);
      }
      
      return dryRun;
    } catch (err: any) {
      // Silently handle errors - no dry runs yet or network issue
      setLatestDryRun(null);
      return null;
    }
  }, []);

  // Poll for updates when dry run is running
  useEffect(() => {
    if (!selected || !dryRunning) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:3001/api/agents/${selected.id}/dry-runs/latest`);
        if (!response.ok) return;
        
        const { data } = await response.json();
        
        // Handle null data
        if (!data) return;
        
        const actualOutput = data.output_data?.output || data.output_data;
        
        setLatestDryRun({
          id: data.id,
          status: data.status,
          output: actualOutput,
          error: data.error_message,
          started_at: data.started_at,
          ended_at: data.ended_at,
          duration_seconds: data.duration_seconds,
          input_data: data.input_data,
        });

        if (data.status !== 'running') {
          setDryRunning(false);
        }
      } catch (err) {
        // Ignore polling errors
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [selected, dryRunning]);

  // Load everything
  const load = useCallback(async () => {
    const [a, t, p, g] = await Promise.all([
      agentsApi.list(), 
      toolsApi.list(), 
      llmApi.list(),
      agentsApi.getGroups()
    ]);
    setAgents(a);
    setTools(t);
    setProviders(p);
    setGroups(g);
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
      max_turns: full.max_turns,
      timeout_ms: full.timeout_ms,
      temperature: full.temperature,
    });
    setIsNew(false);
    
    // Load latest dry run and restore its prompt
    const latestRun = await loadLatestDryRun(full.id);
    if (latestRun) {
      setDryRunPrompt((latestRun.input_data as any)?.prompt || '');
    } else {
      setDryRunPrompt('');
    }
    setDryRunning(false);
  };

  const newAgent = () => {
    setSelected(null);
    setForm(blank());
    setIsNew(true);
    setDryRunPrompt('');
    setDryRunning(false);
    setLatestDryRun(null);
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
        max_turns: form.max_turns || undefined,
        timeout_ms: form.timeout_ms || undefined,
        temperature: form.temperature || undefined,
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

  const autoChooseGroup = async () => {
    if (!form.name?.trim()) {
      alert('Please enter an agent name first');
      return;
    }
    
    setAutoCategorizingGroup(true);
    try {
      const { group } = await agentsApi.autoCategorize(form.name, form.skill ?? '');
      setForm(f => ({ ...f, agent_group: group }));
    } catch (err: any) {
      alert(`Auto-categorization failed: ${err.message}`);
    } finally {
      setAutoCategorizingGroup(false);
    }
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
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
    if (!selected || !dryRunPrompt.trim()) return;
    
    setDryRunning(true);
    setLatestDryRun(null);
    
    try {
      const response = await fetch(`http://localhost:3001/api/agents/${selected.id}/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: dryRunPrompt }),
      });
      
      if (!response.ok) {
        const { error } = await response.json();
        throw new Error(error || 'Failed to start dry run');
      }
      
      // Start polling for updates
      setTimeout(() => loadLatestDryRun(selected.id), 1000);
    } catch (err: any) {
      setDryRunning(false);
      alert(`Failed to start dry run: ${err.message}`);
    }
  };

  const clearDryRun = () => {
    setLatestDryRun(null);
    setDryRunPrompt('');
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

  // Group tools for selection UI dynamically from DB tool_group
  const groupsRaw = tools.reduce<Record<string, ToolRow[]>>((acc, t) => {
    const g = t.tool_group || 'General';
    if (!acc[g]) acc[g] = [];
    acc[g].push(t);
    return acc;
  }, {});

  const groupedTools = Object.keys(groupsRaw)
    .sort((a, b) => {
      if (a === 'Web Search') return -1;
      if (b === 'Web Search') return 1;
      if (a === 'File System') return -1;
      if (b === 'File System') return 1;
      return a.localeCompare(b);
    })
    .map(title => ({
      title,
      items: groupsRaw[title]
    }));

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
          {Object.entries(grouped).map(([group, groupAgents]) => {
            const isCollapsed = collapsedGroups.has(group);
            return (
              <div key={group}>
                {/* Group header — only shown when there are multiple groups or a named group */}
                {(Object.keys(grouped).length > 1 || group !== 'Ungrouped') && (
                  <div 
                    onClick={() => toggleGroup(group)}
                    style={{
                      margin: '8px 10px 6px',
                      padding: '6px 10px',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'var(--text-primary)',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 12,
                      userSelect: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      transition: 'all 150ms ease',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-surface)';
                      e.currentTarget.style.borderColor = 'var(--accent)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--bg-elevated)';
                      e.currentTarget.style.borderColor = 'var(--border)';
                    }}
                  >
                    {isCollapsed ? (
                      <ChevronRight width={12} height={12} style={{ color: 'var(--text-muted)' }} />
                    ) : (
                      <ChevronDown width={12} height={12} style={{ color: 'var(--text-muted)' }} />
                    )}
                    <span style={{ flex: 1 }}>{group}</span>
                    <span style={{ 
                      fontSize: 9,
                      fontWeight: 600,
                      background: 'var(--accent-dim)',
                      color: 'var(--accent-hover)',
                      padding: '2px 7px',
                      borderRadius: 100,
                      minWidth: 20,
                      textAlign: 'center',
                    }}>
                      {groupAgents.length}
                    </span>
                  </div>
                )}
                {!isCollapsed && groupAgents.map(agent => (
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
            );
          })}
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
                  {isNew ? 'Configure and save your agent' : (
                    <>
                      ID: {selected?.id}
                      {selected?.updated_at && (
                        <> · Last updated: {getRelativeTime(selected.updated_at)}</>
                      )}
                    </>
                  )}
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
                <label className="form-label">
                  Group 
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                    (optional — groups agents in the sidebar)
                  </span>
                </label>
                
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                  <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                    <select
                      id="agent-group-select"
                      className="form-select"
                      value={groups.includes(form.agent_group) ? form.agent_group : ''}
                      onChange={e => setForm(f => ({ ...f, agent_group: e.target.value }))}
                      style={{ flex: 1 }}
                    >
                      <option value="">Select existing or type new…</option>
                      {groups.map(g => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                    
                    <input
                      id="agent-group-custom"
                      className="form-input"
                      placeholder="Or type new group…"
                      value={!groups.includes(form.agent_group) ? form.agent_group : ''}
                      onChange={e => setForm(f => ({ ...f, agent_group: e.target.value }))}
                      style={{ flex: 1 }}
                    />
                  </div>
                  
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={autoChooseGroup}
                    disabled={autoCategorizingGroup || !form.name?.trim()}
                    title="Use AI to automatically categorize this agent"
                    style={{ 
                      minWidth: '120px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6
                    }}
                  >
                    {autoCategorizingGroup ? (
                      <>
                        <span className="spinner" style={{ width: 12, height: 12 }} />
                        <span>Analyzing…</span>
                      </>
                    ) : (
                      <>
                        <Zap width={13} height={13} />
                        <span>Auto Choose</span>
                      </>
                    )}
                  </button>
                </div>
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

            {/* ── Execution Constraints card ──────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Settings width={16} height={16} /> Execution Constraints</div>

              <div className="form-group">
                <label className="form-label">
                  Max Turns
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                    (default: 15)
                  </span>
                </label>
                <input
                  type="number"
                  min="1"
                  className="form-input"
                  placeholder="15"
                  value={form.max_turns ?? ''}
                  onChange={e => setForm(f => ({ ...f, max_turns: e.target.value ? parseInt(e.target.value) : undefined }))}
                />
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                  Maximum number of conversation turns before stopping
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">
                  Timeout (ms)
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                    (optional)
                  </span>
                </label>
                <input
                  type="number"
                  min="0"
                  className="form-input"
                  placeholder="No timeout"
                  value={form.timeout_ms ?? ''}
                  onChange={e => setForm(f => ({ ...f, timeout_ms: e.target.value ? parseInt(e.target.value) : undefined }))}
                />
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                  Maximum execution time in milliseconds (leave empty for no timeout)
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  Temperature
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                    (0-2, optional)
                  </span>
                </label>
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  className="form-input"
                  placeholder="Provider default"
                  value={form.temperature ?? ''}
                  onChange={e => setForm(f => ({ ...f, temperature: e.target.value ? parseFloat(e.target.value) : undefined }))}
                />
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                  Controls randomness: 0 = deterministic, 2 = very creative
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
                            title={`${t.description}\n\nRisk Level: ${t.risk_level || 'low'}`}
                          >
                            {t.name}
                            <span className={`risk-badge risk-${t.risk_level || 'low'}`}>
                              {t.risk_level || 'low'}
                            </span>
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div className="card-title" style={{ margin: 0 }}><Play width={16} height={16} /> Dry Run</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {latestDryRun && (
                      <button
                        className="btn btn-ghost"
                        onClick={clearDryRun}
                        title="Clear dry run results"
                        style={{ fontSize: 12, padding: '6px 12px' }}
                      >
                        <X width={13} height={13} /> Clear
                      </button>
                    )}
                    <button
                      className="btn btn-primary"
                      onClick={run}
                      disabled={dryRunning || !dryRunPrompt.trim()}
                      style={{ fontSize: 12, padding: '6px 12px' }}
                    >
                      {dryRunning ? <span className="spinner" /> : <Play width={13} height={13} />}
                      {dryRunning ? 'Executing…' : 'Execute'}
                    </button>
                  </div>
                </div>
                
                <div className="form-group">
                  <label className="form-label">Sample Prompt</label>
                  <textarea
                    id="agent-dry-run-prompt"
                    className="form-textarea"
                    rows={3}
                    placeholder="Type a test prompt for this agent…"
                    value={dryRunPrompt}
                    onChange={e => setDryRunPrompt(e.target.value)}
                    disabled={dryRunning}
                  />
                </div>

                {/* Status indicator */}
                {latestDryRun && (
                  <div style={{ 
                    marginTop: 12, 
                    fontSize: 12, 
                    color: 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8
                  }}>
                    <Clock width={12} height={12} />
                    <span>
                      Last run: {new Date(latestDryRun.started_at).toLocaleString()}
                      {' · '}
                      Status: <strong style={{ 
                        color: latestDryRun.status === 'completed' ? 'var(--green)' : 
                               latestDryRun.status === 'failed' ? 'var(--red)' : 
                               latestDryRun.status === 'running' ? 'var(--accent)' : 
                               'var(--text-muted)'
                      }}>
                        {latestDryRun.status}
                      </strong>
                      {latestDryRun.duration_seconds !== null && (
                        <> · Duration: {latestDryRun.duration_seconds}s</>
                      )}
                    </span>
                  </div>
                )}

                {/* Output display */}
                {latestDryRun?.output && (
                  <div style={{ marginTop: 20 }}>
                    <div
                      ref={outputRef}
                      className="output-panel"
                      style={{
                        whiteSpace: 'pre-wrap',
                        maxHeight: 360,
                        overflowY: 'auto',
                        borderColor: latestDryRun.error ? 'rgba(239,68,68,0.4)' : undefined,
                        fontFamily: 'monospace',
                        fontSize: 13,
                        lineHeight: 1.6,
                      }}
                    >
                      {latestDryRun.output.text || JSON.stringify(latestDryRun.output, null, 2)}
                      {dryRunning && <span style={{ opacity: 0.5, animation: 'pulse 1s infinite' }}>▍</span>}
                    </div>
                    
                    {/* Metadata */}
                    <div className="output-meta">
                      {latestDryRun.output.tokenUsage && (
                        <>
                          <span><Hash width={11} height={11} /> {latestDryRun.output.tokenUsage.inputTokens} in</span>
                          <span><Hash width={11} height={11} /> {latestDryRun.output.tokenUsage.outputTokens} out</span>
                        </>
                      )}
                      {latestDryRun.output.toolsUsed && latestDryRun.output.toolsUsed.length > 0 && (
                        <span><Zap width={11} height={11} /> Tools: {latestDryRun.output.toolsUsed.join(', ')}</span>
                      )}
                      {latestDryRun.output.providerInfo && (
                        <span>🤖 {latestDryRun.output.providerInfo.name} / {latestDryRun.output.providerInfo.model}</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Error display */}
                {latestDryRun?.error && (
                  <div style={{ 
                    marginTop: 20, 
                    padding: 12, 
                    background: 'rgba(239,68,68,0.1)', 
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 8,
                    color: 'var(--red)',
                    fontSize: 13
                  }}>
                    <strong>Error:</strong> {latestDryRun.error}
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
