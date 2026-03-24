'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Wrench, Plus, Save, Trash2, Eye, EyeOff,
  FlaskConical, Plug, ChevronDown, X, RotateCcw, Library, CheckCircle2, Download
} from 'lucide-react';
import { toolsApi, builtinsApi, type ToolRow, type BuiltInToolDef } from '@/lib/api';

// ─── Field type cycle order ────────────────────────────────────────────────────
const FIELD_TYPES = ['text', 'secret', 'select', 'toggle'] as const;
type FieldType = typeof FIELD_TYPES[number];

interface ConfigEntry {
  id: string;        // local-only key for React
  key: string;
  value: string;
  type: FieldType;
  options: string;   // comma-separated, for select type
  show: boolean;     // for secret masking
}

const newEntry = (): ConfigEntry => ({
  id: Math.random().toString(36).slice(2),
  key: '', value: '', type: 'text', options: '', show: false,
});

const blankTool = (): Partial<ToolRow> & { entries: ConfigEntry[] } => ({
  name: '', description: '', is_enabled: true,
  schema: {}, config: {}, entries: [],
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function entriesToConfig(entries: ConfigEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    if (!e.key.trim()) continue;
    if (e.type === 'toggle') {
      out[e.key] = e.value === 'true';
    } else if (e.type === 'select') {
      out[`${e.key}__options`] = e.options;
      out[e.key] = e.value;
    } else {
      out[e.key] = e.value;
    }
    out[`${e.key}__type`] = e.type;
  }
  return out;
}

function configToEntries(config: Record<string, unknown>): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  const seen = new Set<string>();
  for (const rawKey of Object.keys(config)) {
    if (rawKey.endsWith('__type') || rawKey.endsWith('__options')) continue;
    if (seen.has(rawKey)) continue;
    seen.add(rawKey);
    const type = (config[`${rawKey}__type`] as FieldType) ?? 'text';
    const options = (config[`${rawKey}__options`] as string) ?? '';
    entries.push({
      id: Math.random().toString(36).slice(2),
      key: rawKey,
      value: String(config[rawKey] ?? ''),
      type,
      options,
      show: false,
    });
  }
  return entries;
}

// ─── Type pill cycler ─────────────────────────────────────────────────────────
function TypePill({ type, onClick }: { type: FieldType; onClick: () => void }) {
  const labels: Record<FieldType, string> = {
    text: 'Text', secret: '🔑 Secret', select: '▾ Select', toggle: '◉ Toggle',
  };
  return (
    <button className={`type-pill ${type !== 'text' ? type : ''}`} onClick={onClick} type="button" title="Click to change field type">
      {labels[type]}
    </button>
  );
}

// ─── Test connection result state ─────────────────────────────────────────────
type TestState = 'idle' | 'testing' | 'ok' | 'fail';

export default function ToolsPage() {
  const [tools, setTools]           = useState<ToolRow[]>([]);
  const [builtins, setBuiltins]     = useState<BuiltInToolDef[]>([]);
  const [installing, setInstalling] = useState<Record<string, 'idle'|'installing'|'done'>>({});
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [selected, setSelected]     = useState<ToolRow | null>(null);
  const [form, setForm]             = useState(blankTool());
  const [isNew, setIsNew]           = useState(false);
  const [activeTab, setActiveTab]   = useState<'mine' | 'library'>('mine');
  const [search, setSearch]         = useState('');
  const [saving, setSaving]         = useState(false);
  const [testState, setTestState]   = useState<TestState>('idle');

  const load = useCallback(async () => {
    const [data, catalog] = await Promise.all([toolsApi.list(), builtinsApi.list()]);
    setTools(data);
    setBuiltins(catalog);
    setInstalledNames(new Set(data.map(t => t.name)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = tools.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  );

  const select = async (tool: ToolRow) => {
    const full = await toolsApi.get(tool.id);
    setSelected(full);
    setForm({
      name: full.name,
      description: full.description,
      is_enabled: full.is_enabled,
      schema: full.schema ?? {},
      config: full.config ?? {},
      entries: configToEntries(full.config ?? {}),
    });
    setIsNew(false);
    setTestState('idle');
  };

  const newTool = () => {
    setSelected(null);
    setForm(blankTool());
    setIsNew(true);
    setTestState('idle');
  };

  const save = async () => {
    setSaving(true);
    try {
      const config = entriesToConfig(form.entries ?? []);
      const payload = {
        name: form.name ?? '',
        description: form.description ?? '',
        is_enabled: form.is_enabled ?? true,
        schema: form.schema ?? {},
        config,
      };
      if (isNew) {
        const { id } = await toolsApi.create(payload as any);
        await load();
        const created = await toolsApi.get(id);
        setSelected(created);
        setForm({ ...payload, entries: configToEntries(config) });
        setIsNew(false);
      } else if (selected) {
        await toolsApi.update(selected.id, payload as any);
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!selected) return;
    if (!confirm(`Delete tool "${selected.name}"?`)) return;
    await toolsApi.delete(selected.id);
    setSelected(null);
    setForm(blankTool());
    await load();
  };

  const toggle = async (tool: ToolRow, e: React.MouseEvent) => {
    e.stopPropagation();
    await toolsApi.toggle(tool.id, !tool.is_enabled);
    await load();
    if (selected?.id === tool.id) {
      setForm(f => ({ ...f, is_enabled: !tool.is_enabled }));
    }
  };

  const install = async (name: string) => {
    setInstalling(s => ({ ...s, [name]: 'installing' }));
    try {
      await builtinsApi.install(name);
      await load();
      setInstalling(s => ({ ...s, [name]: 'done' }));
      setTimeout(() => setInstalling(s => ({ ...s, [name]: 'idle' })), 2000);
    } catch {
      setInstalling(s => ({ ...s, [name]: 'idle' }));
    }
  };

  // ── Config entries management ──────────────────────────────────────────────
  const addEntry = () => setForm(f => ({ ...f, entries: [...(f.entries ?? []), newEntry()] }));

  const updateEntry = (id: string, patch: Partial<ConfigEntry>) =>
    setForm(f => ({
      ...f,
      entries: (f.entries ?? []).map(e => e.id === id ? { ...e, ...patch } : e),
    }));

  const removeEntry = (id: string) =>
    setForm(f => ({ ...f, entries: (f.entries ?? []).filter(e => e.id !== id) }));

  const cycleType = (id: string, current: FieldType) => {
    const next = FIELD_TYPES[(FIELD_TYPES.indexOf(current) + 1) % FIELD_TYPES.length];
    updateEntry(id, { type: next });
  };

  // ── Test connection ────────────────────────────────────────────────────────
  const testConnection = async () => {
    setTestState('testing');
    try {
      const config = entriesToConfig(form.entries ?? []);
      const endpoint = config['endpoint'] ?? config['url'] ?? config['base_url'] as string;
      if (!endpoint || typeof endpoint !== 'string') {
        setTestState('fail');
        return;
      }
      const res = await fetch(endpoint, {
        method: (config['method'] as string) || 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      setTestState(res.ok ? 'ok' : 'fail');
    } catch {
      setTestState('fail');
    }
    setTimeout(() => setTestState('idle'), 3000);
  };

  const hasEndpoint = (form.entries ?? []).some(e =>
    ['endpoint', 'url', 'base_url'].includes(e.key.toLowerCase())
  );

  const showForm = (isNew || selected !== null) && activeTab === 'mine';

  // Category colors
  const catColor: Record<string, string> = {
    Search: 'var(--accent-hover)',
    Network: 'var(--blue)',
    Files: 'var(--yellow)',
    System: 'var(--red)',
    'Math & Data': 'var(--green)',
  };

  // Group builtins by category
  const builtinsByCategory = builtins.reduce<Record<string, BuiltInToolDef[]>>((acc, t) => {
    if (!acc[t.category]) acc[t.category] = [];
    acc[t.category].push(t);
    return acc;
  }, {});

  return (
    <div className="two-panel">
      {/* ── Left sidebar ────────────────────────────────────────────────── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Tools</h2>
          {activeTab === 'mine' && (
            <button className="btn-icon" onClick={newTool} title="New tool">
              <Plus width={15} height={15} />
            </button>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 8px' }}>
          {(['mine', 'library'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); if (tab === 'library') { setSelected(null); setIsNew(false); } }}
              style={{
                flex: 1, background: 'none', border: 'none', padding: '10px 4px',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                color: activeTab === tab ? 'var(--accent-hover)' : 'var(--text-muted)',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                transition: 'color 0.18s',
              }}
            >
              {tab === 'mine' ? <><Wrench width={12} height={12} /> My Tools</> : <><Library width={12} height={12} /> Built-in</>}
            </button>
          ))}
        </div>

        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search tools…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="list-scroll">
          {filtered.length === 0 && (
            <div className="empty-state">
              <Wrench width={32} height={32} />
              <p>No tools yet.<br />Click + to add one.</p>
            </div>
          )}
          {filtered.map(tool => (
            <div
              key={tool.id}
              className={`list-item${selected?.id === tool.id ? ' selected' : ''}`}
              onClick={() => select(tool)}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div className="list-item-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tool.name}
                </div>
                {/* Inline enabled toggle */}
                <label className="toggle" style={{ flexShrink: 0 }} onClick={e => toggle(tool, e)}>
                  <input type="checkbox" checked={tool.is_enabled} readOnly />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="list-item-meta">{tool.description || 'No description'}</div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Right panel ─────────────────────────────────────────────────── */}
      <div className="panel-right">
        {/* ── Library tab view ──────────────────────────────────────────── */}
        {activeTab === 'library' && (
          <>
            <div className="page-title">Built-in Tool Library</div>
            <div className="page-subtitle">One-click install for common tools. Installed tools appear in your tool list and can be assigned to agents.</div>

            {Object.entries(builtinsByCategory).map(([cat, catTools]) => (
              <div key={cat} style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: catColor[cat] ?? 'var(--text-muted)', marginBottom: 12 }}>
                  {cat}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                  {catTools.map(tool => {
                    const state = installing[tool.name] ?? 'idle';
                    const isInstalled = installedNames.has(tool.name);
                    return (
                      <div key={tool.name} style={{
                        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-lg)', padding: '18px 20px',
                        display: 'flex', flexDirection: 'column', gap: 8,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ fontSize: 24, lineHeight: 1 }}>{tool.icon}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 2 }}>{tool.name}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{tool.tagline}</div>
                          </div>
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>{tool.description}</p>
                        <div style={{ marginTop: 4 }}>
                          {isInstalled ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--green)' }}>
                              <CheckCircle2 width={14} height={14} /> Installed
                            </div>
                          ) : (
                            <button
                              className="btn btn-ghost"
                              style={{ fontSize: 12, padding: '5px 14px' }}
                              disabled={state !== 'idle'}
                              onClick={() => install(tool.name)}
                            >
                              {state === 'installing' ? <span className="spinner" /> : <Download width={13} height={13} />}
                              {state === 'installing' ? 'Installing…' : state === 'done' ? '✓ Done' : 'Install'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ── My Tools tab ──────────────────────────────────────────────── */}
        {activeTab === 'mine' && !showForm && (
          <div className="empty-state" style={{ height: '100%' }}>
            <Wrench width={48} height={48} />
            <p>Select a tool to edit, or click <strong>+</strong> to create one.</p>
            <button className="btn btn-primary" onClick={newTool}>
              <Plus width={14} height={14} /> New Tool
            </button>
          </div>
        )}

        {activeTab === 'mine' && showForm && (
          <>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div className="page-title">{isNew ? 'New Tool' : selected?.name}</div>
                <div className="page-subtitle">
                  {isNew ? 'Define tool identity and configuration' : `ID: ${selected?.id}`}
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
                  {saving ? 'Saving…' : 'Save Tool'}
                </button>
              </div>
            </div>

            {/* ── Identity card ──────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Plug width={16} height={16} /> Identity</div>

              <div className="form-group">
                <label className="form-label">Tool Name</label>
                <input
                  id="tool-name"
                  className="form-input"
                  placeholder="e.g. Slack Notifier, Weather API, SQL Query…"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Description <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(shown to the LLM to decide when to use this tool)</span></label>
                <textarea
                  id="tool-description"
                  className="form-textarea"
                  rows={3}
                  placeholder="Describe what this tool does and when the LLM should invoke it…"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div className="toggle-wrap" style={{ marginBottom: 0 }}>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={form.is_enabled ?? true}
                    onChange={e => setForm(f => ({ ...f, is_enabled: e.target.checked }))}
                  />
                  <span className="toggle-track" />
                </label>
                <span style={{ fontSize: 13, color: form.is_enabled ? 'var(--green)' : 'var(--text-muted)' }}>
                  {form.is_enabled ? 'Enabled — agents can use this tool' : 'Disabled — hidden from agents'}
                </span>
              </div>
            </div>

            {/* ── Configuration card ─────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Wrench width={16} height={16} /> Configuration</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                Add key-value configuration for this tool (API endpoints, auth tokens, etc.). Click a field type badge to cycle through: <strong>Text → Secret → Select → Toggle</strong>.
              </p>

              {/* Column headers */}
              {(form.entries ?? []).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6, padding: '0 2px' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>KEY</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>VALUE</span>
                  <span style={{ width: 88 }} />
                </div>
              )}

              {(form.entries ?? []).map(entry => (
                <div key={entry.id} className="kv-row">
                  {/* Key input */}
                  <input
                    className="form-input"
                    placeholder="key"
                    style={{ fontSize: 13 }}
                    value={entry.key}
                    onChange={e => updateEntry(entry.id, { key: e.target.value })}
                  />

                  {/* Value input — adapts to type */}
                  {entry.type === 'toggle' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={entry.value === 'true'}
                          onChange={e => updateEntry(entry.id, { value: e.target.checked ? 'true' : 'false' })}
                        />
                        <span className="toggle-track" />
                      </label>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{entry.value === 'true' ? 'On' : 'Off'}</span>
                    </div>
                  ) : entry.type === 'select' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <input
                        className="form-input"
                        placeholder="options (comma-separated)"
                        style={{ fontSize: 12, padding: '5px 10px' }}
                        value={entry.options}
                        onChange={e => updateEntry(entry.id, { options: e.target.value })}
                      />
                      <select
                        className="form-select"
                        style={{ fontSize: 12, padding: '5px 10px' }}
                        value={entry.value}
                        onChange={e => updateEntry(entry.id, { value: e.target.value })}
                      >
                        <option value="">— select —</option>
                        {entry.options.split(',').map(o => o.trim()).filter(Boolean).map(o => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div style={{ position: 'relative' }}>
                      <input
                        className="form-input"
                        style={{ fontSize: 13, paddingRight: entry.type === 'secret' ? 36 : undefined }}
                        type={entry.type === 'secret' && !entry.show ? 'password' : 'text'}
                        placeholder={entry.type === 'secret' ? '••••••••' : 'value'}
                        value={entry.value}
                        onChange={e => updateEntry(entry.id, { value: e.target.value })}
                      />
                      {entry.type === 'secret' && (
                        <button
                          type="button"
                          className="btn-icon"
                          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', padding: 4 }}
                          onClick={() => updateEntry(entry.id, { show: !entry.show })}
                        >
                          {entry.show ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Type pill + delete */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TypePill type={entry.type} onClick={() => cycleType(entry.id, entry.type)} />
                    <button className="btn-icon" onClick={() => removeEntry(entry.id)} title="Remove field" style={{ padding: 5 }}>
                      <X width={13} height={13} />
                    </button>
                  </div>
                </div>
              ))}

              <button
                className="btn btn-ghost"
                style={{ marginTop: 12, fontSize: 12, padding: '6px 14px' }}
                onClick={addEntry}
              >
                <Plus width={13} height={13} /> Add Parameter
              </button>

              {/* Test connection — only shown if an endpoint/url key exists */}
              {(hasEndpoint || !isNew) && (
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, padding: '6px 14px' }}
                    onClick={testConnection}
                    disabled={testState === 'testing'}
                  >
                    {testState === 'testing' ? <span className="spinner" /> : <FlaskConical width={13} height={13} />}
                    {testState === 'testing' ? 'Testing…' : 'Test Connection'}
                  </button>
                  {testState === 'ok' && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Reachable</span>}
                  {testState === 'fail' && <span style={{ fontSize: 12, color: 'var(--red)' }}>✗ Failed — check endpoint key &amp; value</span>}
                  {testState === 'idle' && hasEndpoint && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Test the configured endpoint before saving</span>
                  )}
                </div>
              )}
            </div>

            {/* ── JSON Schema card (collapsible) ─────────────────────────── */}
            <JsonSchemaCard
              value={form.schema ?? {}}
              onChange={schema => setForm(f => ({ ...f, schema }))}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ─── JSON Schema card (collapsible) ───────────────────────────────────────────
function JsonSchemaCard({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(JSON.stringify(value, null, 2));
  const [err, setErr] = useState('');

  const apply = () => {
    try {
      onChange(JSON.parse(raw));
      setErr('');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="card">
      <button
        type="button"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-primary)', padding: 0,
        }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
          <ChevronDown width={16} height={16} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.18s' }} />
          JSON Schema <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>(for LLM tool-calling spec)</span>
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Defines the parameters the LLM must provide when calling this tool.
            Follows <a href="https://json-schema.org" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-hover)' }}>JSON Schema draft-07</a>.
          </p>
          <textarea
            className="form-textarea"
            rows={10}
            style={{ fontFamily: "'Fira Code', monospace", fontSize: 12 }}
            value={raw}
            onChange={e => setRaw(e.target.value)}
          />
          {err && <p style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>JSON error: {err}</p>}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={apply}>
              <Save width={12} height={12} /> Apply Schema
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--text-muted)' }}
              onClick={() => { setRaw(JSON.stringify(value, null, 2)); setErr(''); }}>
              <RotateCcw width={12} height={12} /> Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
