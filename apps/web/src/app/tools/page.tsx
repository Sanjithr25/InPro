'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Wrench, Plus, Save, Trash2, Eye, EyeOff,
  FlaskConical, Plug, ChevronDown, X, RotateCcw, Zap,
} from 'lucide-react';
import { toolsApi, type ToolRow } from '@/lib/api';

// ─── Types ─────────────────────────────────────────────────────────────────────
const FIELD_TYPES = ['text', 'secret', 'select', 'toggle'] as const;
type FieldType = typeof FIELD_TYPES[number];

interface ConfigEntry {
  id: string;
  key: string;
  value: string;
  type: FieldType;
  options: string;
  show: boolean;
}

const newEntry = (): ConfigEntry => ({
  id: Math.random().toString(36).slice(2),
  key: '', value: '', type: 'text', options: '', show: false,
});

const blankTool = (): Partial<ToolRow> & { entries: ConfigEntry[] } => ({
  name: '', description: '', is_enabled: true,
  schema: {}, config: {}, is_builtin: false, entries: [],
});

// ─── Config helpers ────────────────────────────────────────────────────────────
function entriesToConfig(entries: ConfigEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    if (!e.key.trim()) continue;
    if (e.type === 'toggle')      { out[e.key] = e.value === 'true'; }
    else if (e.type === 'select') { out[`${e.key}__options`] = e.options; out[e.key] = e.value; }
    else                          { out[e.key] = e.value; }
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
    entries.push({
      id: Math.random().toString(36).slice(2),
      key: rawKey,
      value: String(config[rawKey] ?? ''),
      type: (config[`${rawKey}__type`] as FieldType) ?? 'text',
      options: (config[`${rawKey}__options`] as string) ?? '',
      show: false,
    });
  }
  return entries;
}

// ─── Sub-components ────────────────────────────────────────────────────────────
function TypePill({ type, onClick }: { type: FieldType; onClick: () => void }) {
  const labels: Record<FieldType, string> = {
    text: 'Text', secret: '🔑 Secret', select: '▾ Select', toggle: '◉ Toggle',
  };
  return (
    <button className={`type-pill ${type !== 'text' ? type : ''}`} onClick={onClick} type="button" title="Click to change type">
      {labels[type]}
    </button>
  );
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

// ─── Page ──────────────────────────────────────────────────────────────────────
export default function ToolsPage() {
  const [tools, setTools]     = useState<ToolRow[]>([]);
  const [selected, setSelected] = useState<ToolRow | null>(null);
  const [form, setForm]       = useState(blankTool());
  const [isNew, setIsNew]     = useState(false);
  const [search, setSearch]   = useState('');
  const [saving, setSaving]   = useState(false);
  const [testState, setTestState] = useState<TestState>('idle');

  const load = useCallback(async () => {
    setTools(await toolsApi.list());
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = tools.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  );

  const FS_NAMES = new Set(['read_file', 'write_file', 'delete_file', 'list_directory', 'find_files', 'search_files']);
  const groups = [
    { title: 'File System', icon: '📁', items: filtered.filter(t => FS_NAMES.has(t.name)) },
    { title: 'Built-ins',   icon: '⚡', items: filtered.filter(t => t.is_builtin && !FS_NAMES.has(t.name)) },
    { title: 'Custom',      icon: '🔌', items: filtered.filter(t => !t.is_builtin && !FS_NAMES.has(t.name)) },
  ];

  // ── Counts ──────────────────────────────────────────────────────────────────
  const activeCount  = tools.filter(t => t.is_enabled).length;
  const builtinCount = tools.filter(t => t.is_builtin).length;

  // ── Select ─────────────────────────────────────────────────────────────────
  const selectTool = async (tool: ToolRow) => {
    const full = await toolsApi.get(tool.id);
    setSelected(full);
    setForm({
      name: full.name, description: full.description,
      is_enabled: full.is_enabled, is_builtin: full.is_builtin,
      schema: full.schema ?? {}, config: full.config ?? {},
      entries: configToEntries(full.config ?? {}),
    });
    setIsNew(false);
    setTestState('idle');
  };

  // ── New ────────────────────────────────────────────────────────────────────
  const newTool = () => {
    setSelected(null);
    setForm(blankTool());
    setIsNew(true);
    setTestState('idle');
  };

  // ── Save ───────────────────────────────────────────────────────────────────
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
        setForm({ ...payload, is_builtin: false, entries: configToEntries(config) });
        setIsNew(false);
      } else if (selected) {
        await toolsApi.update(selected.id, payload as any);
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const del = async () => {
    if (!selected) return;
    if (!confirm(`Delete "${selected.name}"?`)) return;
    await toolsApi.delete(selected.id);
    setSelected(null);
    setForm(blankTool());
    await load();
  };

  // ── Toggle ─────────────────────────────────────────────────────────────────
  const toggle = async (tool: ToolRow, e: React.MouseEvent) => {
    e.stopPropagation();
    await toolsApi.toggle(tool.id, !tool.is_enabled);
    await load();
    if (selected?.id === tool.id) setForm(f => ({ ...f, is_enabled: !tool.is_enabled }));
  };

  // ── Config entries ─────────────────────────────────────────────────────────
  const addEntry    = () => setForm(f => ({ ...f, entries: [...(f.entries ?? []), newEntry()] }));
  const updateEntry = (id: string, patch: Partial<ConfigEntry>) =>
    setForm(f => ({ ...f, entries: (f.entries ?? []).map(e => e.id === id ? { ...e, ...patch } : e) }));
  const removeEntry = (id: string) =>
    setForm(f => ({ ...f, entries: (f.entries ?? []).filter(e => e.id !== id) }));
  const cycleType   = (id: string, cur: FieldType) =>
    updateEntry(id, { type: FIELD_TYPES[(FIELD_TYPES.indexOf(cur) + 1) % FIELD_TYPES.length] });

  // ── Test connection ────────────────────────────────────────────────────────
  const testConnection = async () => {
    setTestState('testing');
    try {
      const config   = entriesToConfig(form.entries ?? []);
      const endpoint = config['endpoint'] ?? config['url'] ?? config['base_url'] as string;
      if (!endpoint || typeof endpoint !== 'string') { setTestState('fail'); return; }
      const res = await fetch(endpoint, {
        method: (config['method'] as string) || 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      setTestState(res.ok ? 'ok' : 'fail');
    } catch { setTestState('fail'); }
    setTimeout(() => setTestState('idle'), 3500);
  };

  const hasEndpoint = (form.entries ?? []).some(e =>
    ['endpoint', 'url', 'base_url'].includes(e.key.toLowerCase())
  );
  const showForm = isNew || selected !== null;

  return (
    <div className="two-panel">

      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Tools</h2>
          <button className="btn-icon" onClick={newTool} title="New tool">
            <Plus width={15} height={15} />
          </button>
        </div>

        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search tools…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Stats */}
        {tools.length > 0 && (
          <div style={{
            fontSize: 11, color: 'var(--text-muted)',
            padding: '4px 14px 8px',
            display: 'flex', gap: 8, flexWrap: 'wrap',
          }}>
            <span>{activeCount} active</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{tools.length} total</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{builtinCount} built-in</span>
          </div>
        )}

        <div className="list-scroll">
          {filtered.length === 0 && (
            <div className="empty-state">
              <Wrench width={32} height={32} />
              <p>No tools yet.<br />Click + to create one.</p>
            </div>
          )}

          {groups.map(g => g.items.length > 0 && (
            <div key={g.title} style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.07em', color: 'var(--text-muted)',
                padding: '4px 12px 2px', display: 'flex', alignItems: 'center', gap: 5,
              }}>
                <span>{g.icon}</span> {g.title}
              </div>
              {g.items.map(tool => (
                <div
                  key={tool.id}
                  className={`list-item${selected?.id === tool.id ? ' selected' : ''}`}
                  onClick={() => selectTool(tool)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                      <span className="list-item-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tool.name}
                      </span>
                      {tool.is_builtin && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                          padding: '1px 5px', borderRadius: 10, flexShrink: 0,
                          background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                          color: 'var(--accent-hover)',
                          border: '1px solid color-mix(in srgb, var(--accent) 28%, transparent)',
                        }}>
                          BUILT-IN
                        </span>
                      )}
                    </div>
                    <label className="toggle" style={{ flexShrink: 0 }} onClick={e => toggle(tool, e)}>
                      <input type="checkbox" checked={tool.is_enabled} readOnly />
                      <span className="toggle-track" />
                    </label>
                  </div>
                  <div className="list-item-meta" style={{ marginTop: 4, lineHeight: 1.4, opacity: 0.8 }}>
                    {tool.description.substring(0, 50)}…
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* ── Right panel ───────────────────────────────────────────────────── */}
      <div className="panel-right">

        {/* Empty state */}
        {!showForm && (
          <div className="empty-state" style={{ height: '100%' }}>
            <Wrench width={48} height={48} />
            <p>Select a tool to configure,<br />or click <strong>+</strong> to create a new one.</p>
            <button className="btn btn-primary" onClick={newTool}>
              <Plus width={14} height={14} /> New Tool
            </button>
          </div>
        )}

        {/* Tool form */}
        {showForm && (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ minWidth: 0 }}>
                <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  {isNew ? 'New Tool' : selected?.name}
                  {!isNew && selected?.is_builtin && (
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                      background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                      color: 'var(--accent-hover)',
                      border: '1px solid color-mix(in srgb, var(--accent) 28%, transparent)',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}>
                      <Zap width={10} height={10} /> Built-in
                    </span>
                  )}
                </div>
                <div className="page-subtitle">
                  {isNew ? 'Define name, description, configuration, and schema' : `ID: ${selected?.id}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {!isNew && (
                  <button className="btn btn-danger" onClick={del}>
                    <Trash2 width={14} height={14} /> Delete
                  </button>
                )}
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? <span className="spinner" /> : <Save width={14} height={14} />}
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            {/* Identity */}
            <div className="card">
              <div className="card-title"><Plug width={16} height={16} /> Identity</div>

              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  id="tool-name"
                  className="form-input"
                  placeholder="e.g. slack_notifier, weather_api, sql_query…"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Use snake_case. Names matching built-ins (web_search, calculator, http_request, etc.) run natively.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">
                  Description{' '}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                    — tell the LLM when and why to call this tool
                  </span>
                </label>
                <textarea
                  id="tool-description"
                  className="form-textarea"
                  rows={3}
                  placeholder="Use when you need to… Do NOT use for… Returns…"
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

            {/* Configuration */}
            <div className="card">
              <div className="card-title"><Wrench width={16} height={16} /> Configuration</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                Key-value config stored in the DB (API keys, endpoints, timeouts). 
                Click a type badge to cycle: <strong>Text → Secret → Select → Toggle</strong>.
              </p>

              {(form.entries ?? []).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 6, padding: '0 2px' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>KEY</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>VALUE</span>
                  <span style={{ width: 88 }} />
                </div>
              )}

              {(form.entries ?? []).map(entry => (
                <div key={entry.id} className="kv-row">
                  <input
                    className="form-input"
                    placeholder="key"
                    style={{ fontSize: 13 }}
                    value={entry.key}
                    onChange={e => updateEntry(entry.id, { key: e.target.value })}
                  />

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
                          type="button" className="btn-icon"
                          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', padding: 4 }}
                          onClick={() => updateEntry(entry.id, { show: !entry.show })}
                        >
                          {entry.show ? <EyeOff width={13} height={13} /> : <Eye width={13} height={13} />}
                        </button>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TypePill type={entry.type} onClick={() => cycleType(entry.id, entry.type)} />
                    <button className="btn-icon" onClick={() => removeEntry(entry.id)} title="Remove" style={{ padding: 5 }}>
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
                  {testState === 'ok'   && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Reachable</span>}
                  {testState === 'fail' && <span style={{ fontSize: 12, color: 'var(--red)' }}>✗ Failed — check endpoint &amp; auth</span>}
                  {testState === 'idle' && hasEndpoint && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Test the endpoint before saving</span>
                  )}
                </div>
              )}
            </div>

            {/* JSON Schema (collapsible) */}
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

// ─── JSON Schema card ──────────────────────────────────────────────────────────
function JsonSchemaCard({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw]   = useState(JSON.stringify(value, null, 2));
  const [err, setErr]   = useState('');

  const apply = () => {
    try { onChange(JSON.parse(raw)); setErr(''); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="card">
      <button
        type="button"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', padding: 0 }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
          <ChevronDown width={16} height={16} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.18s' }} />
          JSON Schema
          <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>
            (LLM function-calling spec)
          </span>
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Defines parameters the LLM must supply when calling this tool.
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
