'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Wrench, Settings, ShieldAlert, FolderOpen, Loader2, X,
  ChevronRight, ChevronDown, Edit2, Save, Code2, AlertTriangle,
  Globe, Terminal, FileCode,
} from 'lucide-react';
import { toolsApi, fsApi, settingsApi, type ToolRow, type FsBrowseResult } from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GROUP_ORDER: Record<string, number> = {
  'Web Operations':    1,
  'File Operations':   2,
  'System Operations': 3,
};
const GROUP_ICONS: Record<string, React.ReactNode> = {
  'Web Operations':    <Globe    width={12} height={12} />,
  'File Operations':   <FileCode width={12} height={12} />,
  'System Operations': <Terminal width={12} height={12} />,
};

const LS_KEY = 'tools-collapsed-groups';
const loadCollapsed = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); }
  catch { return new Set(); }
};
const saveCollapsed = (s: Set<string>) =>
  localStorage.setItem(LS_KEY, JSON.stringify([...s]));

// ─── Directory Picker Modal ───────────────────────────────────────────────────
// Uses the backend fsApi so we always get a real absolute path.

function DirPicker({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) {
  const [browse, setBrowse] = useState<FsBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);

  const go = async (path: string) => {
    setLoading(true);
    try { setBrowse(await fsApi.browse(path)); }
    catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    fsApi.home().then(h => go(h.home)).catch(() => go('C:\\'));
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 16, padding: 28, width: 500, maxHeight: '72vh',
        display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FolderOpen width={18} height={18} style={{ color: 'var(--accent-hover)' }} />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Choose Sandbox Root</span>
          </div>
          <button className="btn-icon" onClick={onClose}><X width={14} height={14} /></button>
        </div>

        {/* Current path breadcrumb */}
        <div style={{
          background: 'var(--bg-base)', borderRadius: 8, padding: '7px 12px',
          fontSize: 12, color: 'var(--accent-hover)', wordBreak: 'break-all',
          fontFamily: 'monospace', border: '1px solid var(--border)',
        }}>
          {browse?.current || '…'}
        </div>

        {/* Directory listing */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <Loader2 width={22} height={22} className="spin" />
            </div>
          ) : (
            <>
              {browse?.parent && (
                <button
                  className="nav-item"
                  style={{ fontWeight: 500, fontSize: 13, gap: 8, color: 'var(--text-muted)' }}
                  onClick={() => go(browse.parent!)}
                >
                  <ChevronRight width={13} height={13} style={{ transform: 'rotate(180deg)' }} />
                  .. (Up)
                </button>
              )}
              {browse?.children.map(child => (
                <button
                  key={child.path}
                  className="nav-item"
                  style={{ justifyContent: 'flex-start', gap: 8, fontWeight: 400, fontSize: 13 }}
                  onClick={() => go(child.path)}
                >
                  <FolderOpen width={14} height={14} style={{ color: 'var(--accent-hover)', flexShrink: 0 }} />
                  {child.name}
                </button>
              ))}
              {browse?.children.length === 0 && (
                <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No subfolders — select this directory
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { if (browse) { onSelect(browse.current); onClose(); } }}>
            <FolderOpen width={14} height={14} /> Select This Folder
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── JSON Schema Viewer ───────────────────────────────────────────────────────

function SchemaViewer({ schema }: { schema: Record<string, unknown> }) {
  const props = (schema.properties as Record<string, { type?: string; description?: string }>) || {};
  const required = (schema.required as string[]) || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Object.entries(props).map(([key, prop]) => (
        <div key={key} style={{
          background: 'var(--bg-base)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '10px 14px',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{
              fontFamily: 'monospace', fontSize: 12, fontWeight: 700,
              color: 'var(--accent-hover)', background: 'var(--accent-dim)',
              padding: '1px 6px', borderRadius: 4,
            }}>{key}</code>
            <span style={{
              fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
              color: 'var(--text-muted)', letterSpacing: '0.04em',
            }}>{prop.type ?? 'any'}</span>
            {required.includes(key) && (
              <span style={{
                fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                color: 'var(--red)', background: 'rgba(239,68,68,0.1)',
                padding: '1px 5px', borderRadius: 3,
              }}>required</span>
            )}
          </div>
          {prop.description && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{prop.description}</div>
          )}
        </div>
      ))}
      {Object.keys(props).length === 0 && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No parameters</span>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function ToolsPage() {
  const [tools, setTools]         = useState<ToolRow[]>([]);
  const [selected, setSelected]   = useState<ToolRow | null>(null);
  const [form, setForm]           = useState<ToolRow | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [rootDir, setRootDir]     = useState('');
  const [search, setSearch]       = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen]           = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);

  // ── Load ─────────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const [ts, st] = await Promise.all([toolsApi.list(), settingsApi.get()]);
      setTools(ts);
      if (st.root_directory) setRootDir(JSON.parse(st.root_directory));
    } catch {}
  }, []);

  useEffect(() => {
    load();
    setCollapsedGroups(loadCollapsed());
  }, [load]);

  // ── Grouping ──────────────────────────────────────────────────────────────────
  const filtered = tools.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  );

  const groupsRaw = filtered.reduce<Record<string, ToolRow[]>>((acc, t) => {
    const g = t.tool_group || 'General';
    if (!acc[g]) acc[g] = [];
    acc[g].push(t);
    return acc;
  }, {});

  const groups = Object.keys(groupsRaw).sort((a, b) =>
    (GROUP_ORDER[a] || 99) - (GROUP_ORDER[b] || 99)
  );

  const toggleGroup = (g: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      saveCollapsed(next);
      return next;
    });
  };

  // ── Selection ─────────────────────────────────────────────────────────────────
  const selectTool = (tool: ToolRow) => {
    setSelected(tool);
    setForm({ ...tool });
    setIsEditing(false);
    setSchemaOpen(false);
    setShowGlobalSettings(false);
  };

  const cancelEdit = () => {
    if (selected) setForm({ ...selected });
    setIsEditing(false);
  };

  // ── Inline enable toggle (sidebar) ───────────────────────────────────────────
  // Uses stopPropagation on the wrapping button to avoid triggering selectTool
  const toggleEnable = async (id: string) => {
    const tool = tools.find(t => t.id === id);
    if (!tool) return;
    const next = !tool.is_enabled;
    // Optimistic update
    setTools(ts => ts.map(t => t.id === id ? { ...t, is_enabled: next } : t));
    if (selected?.id === id) {
      setSelected(s => s ? { ...s, is_enabled: next } : s);
      setForm(f => f ? { ...f, is_enabled: next } : f);
    }
    await toolsApi.update(id, { is_enabled: next });
  };

  // ── Save ──────────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!form || !selected) return;
    setSaving(true);
    try {
      await toolsApi.update(selected.id, {
        risk_level: form.risk_level,
        description: form.description,
      });
      setTools(ts => ts.map(t => t.id === selected.id ? { ...t, ...form } : t));
      setSelected({ ...form });
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  // ── Root dir ──────────────────────────────────────────────────────────────────
  const updateRootDir = async (path: string) => {
    setRootDir(path);
    await settingsApi.set('root_directory', JSON.stringify(path));
  };

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="two-panel">
      {pickerOpen && <DirPicker onClose={() => setPickerOpen(false)} onSelect={updateRootDir} />}

      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Tools</h2>
          <button
            className="btn-icon"
            onClick={() => { setShowGlobalSettings(s => !s); setSelected(null); setIsEditing(false); }}
            title="Global Settings"
            style={{ color: showGlobalSettings ? 'var(--accent)' : 'inherit' }}
          >
            <Settings width={15} height={15} />
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

        <div className="list-scroll">
          {groups.map(g => {
            const isCollapsed = collapsedGroups.has(g);
            return (
              <div key={g}>
                {/* Group header — exact same style as agents page */}
                <div
                  onClick={() => toggleGroup(g)}
                  style={{
                    margin: '8px 10px 6px',
                    padding: '6px 10px',
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                    textTransform: 'uppercase', color: 'var(--text-primary)',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    borderRadius: 12, userSelect: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8,
                    transition: 'all 150ms ease',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--bg-surface)';
                    e.currentTarget.style.borderColor = 'var(--accent)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'var(--bg-elevated)';
                    e.currentTarget.style.borderColor = 'var(--border)';
                  }}
                >
                  {isCollapsed
                    ? <ChevronRight width={12} height={12} style={{ color: 'var(--text-muted)' }} />
                    : <ChevronDown  width={12} height={12} style={{ color: 'var(--text-muted)' }} />}
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {GROUP_ICONS[g]} {g}
                  </span>
                  {/* Count badge — same accent pill as agents page */}
                  <span style={{
                    fontSize: 9, fontWeight: 600,
                    background: 'var(--accent-dim)', color: 'var(--accent-hover)',
                    padding: '2px 7px', borderRadius: 100,
                    minWidth: 20, textAlign: 'center',
                  }}>
                    {groupsRaw[g].length}
                  </span>
                </div>

                {!isCollapsed && groupsRaw[g].map(tool => (
                  <div
                    key={tool.id}
                    className={`list-item ${selected?.id === tool.id ? 'selected' : ''}`}
                    onClick={() => selectTool(tool)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 10 }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="list-item-name" style={{ fontSize: 14 }}>{tool.name}</span>
                        <span className={`risk-badge risk-${tool.risk_level}`} style={{ marginLeft: 0, flexShrink: 0 }}>
                          {tool.risk_level}
                        </span>
                      </div>
                    </div>

                    {/* Toggle — isolated in its own div to prevent click bubbling */}
                    <div
                      onClick={e => { e.stopPropagation(); toggleEnable(tool.id); }}
                      style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}
                      title={tool.is_enabled ? 'Click to disable' : 'Click to enable'}
                    >
                      <label className="toggle" style={{ pointerEvents: 'none' }}>
                        <input type="checkbox" checked={tool.is_enabled} onChange={() => {}} />
                        <span className="toggle-track" />
                      </label>
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

        {/* Empty state */}
        {!showGlobalSettings && !selected && (
          <div className="empty-state" style={{ height: '100%' }}>
            <Wrench width={48} height={48} />
            <p>
              Select a tool from the sidebar to view its details,<br />
              or click <Settings width={14} height={14} style={{ display: 'inline', opacity: 0.7 }} /> for global settings.
            </p>
          </div>
        )}

        {/* ── Global Settings ──────────────────────────────────────────────── */}
        {showGlobalSettings && (
          <div style={{ maxWidth: 900 }}>
            <div className="page-title">Global Tool Settings</div>
            <div className="page-subtitle">Sandboxing and system-wide security policies.</div>

            <div className="card">
              <div className="card-title"><FolderOpen width={16} height={16} /> Sandbox Root Directory</div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    readOnly
                    className="form-input"
                    value={rootDir || 'Documents (default)'}
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }}
                  />
                  <button className="btn btn-ghost" onClick={() => setPickerOpen(true)}>
                    <FolderOpen width={14} height={14} /> Browse
                  </button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  All file-system tools are strictly confined to this path. Traversal attempts (e.g. <code>../</code>) are blocked.
                </p>
              </div>
            </div>

            <div className="card">
              <div className="card-title" style={{ color: 'var(--red)' }}>
                <ShieldAlert width={16} height={16} /> Security Policies
              </div>
              <ul style={{ fontSize: 13, color: 'var(--text-secondary)', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <li><strong>High Risk Policy:</strong> High-risk tools are automatically disabled during Dry Runs.</li>
                <li><strong>Command Filtering:</strong> The bash tool permanently blocks destructive verbs (<code>rm</code>, <code>sudo</code>, etc.).</li>
                <li><strong>Output Safety:</strong> All tool results are truncated to protect LLM context windows.</li>
              </ul>
            </div>

            {/* Tools Overview — connected to live tools state */}
            <div className="card">
              <div className="card-title"><Wrench width={16} height={16} /> Tools Overview</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {/* Table header */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 140px 100px 80px',
                  padding: '8px 12px', background: 'var(--bg-subtle)',
                  borderRadius: '8px 8px 0 0', border: '1px solid var(--border)',
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.06em', color: 'var(--text-muted)', gap: 12,
                }}>
                  <span>Tool</span>
                  <span>Group</span>
                  <span>Risk</span>
                  <span>Status</span>
                </div>
                {tools.map((tool, idx) => (
                  <div key={tool.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr 140px 100px 80px',
                    padding: '10px 12px', gap: 12,
                    border: '1px solid var(--border)', borderTop: 'none',
                    borderRadius: idx === tools.length - 1 ? '0 0 8px 8px' : 0,
                    background: idx % 2 === 0 ? 'var(--bg-base)' : 'var(--bg-elevated)',
                    alignItems: 'center',
                    cursor: 'pointer',
                    transition: 'background 150ms ease',
                  }}
                  onClick={() => { selectTool(tool); setShowGlobalSettings(false); }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = idx % 2 === 0 ? 'var(--bg-base)' : 'var(--bg-elevated)')}
                  >
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{tool.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tool.tool_group}</span>
                    <span><span className={`risk-badge risk-${tool.risk_level}`} style={{ marginLeft: 0 }}>{tool.risk_level}</span></span>
                    <span style={{
                      fontSize: 11, fontWeight: 600,
                      color: tool.is_enabled ? 'var(--green)' : 'var(--text-muted)',
                    }}>
                      {tool.is_enabled ? 'On' : 'Off'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Tool Detail ──────────────────────────────────────────────────── */}
        {selected && form && !showGlobalSettings && (
          <div style={{ width: '100%' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div className="page-title">{selected.name}</div>
                <div className="page-subtitle" style={{ marginBottom: 0 }}>
                  {selected.tool_group} capability ·{' '}
                  <span style={{ color: selected.is_enabled ? 'var(--green)' : 'var(--text-muted)' }}>
                    {selected.is_enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  {' '}(toggle in sidebar)
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!isEditing ? (
                  <button className="btn btn-ghost" onClick={() => setIsEditing(true)}>
                    <Edit2 width={14} height={14} /> Edit
                  </button>
                ) : (
                  <>
                    <button className="btn btn-ghost" onClick={cancelEdit}>
                      <X width={14} height={14} /> Cancel
                    </button>
                    <button className="btn btn-primary" onClick={save} disabled={saving}>
                      {saving ? <span className="spinner" /> : <Save width={14} height={14} />}
                      {saving ? 'Saving…' : 'Save Changes'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Two-column body */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>

              {/* Left col — description + risk */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {/* Description */}
                <div className="card">
                  <div className="card-title"><Wrench width={16} height={16} /> Description</div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <textarea
                      className="form-textarea"
                      value={form.description}
                      onChange={e => setForm(f => f ? { ...f, description: e.target.value } : f)}
                      disabled={!isEditing}
                      style={{ fontSize: 13.5, minHeight: 120 }}
                    />
                  </div>
                </div>

                {/* Risk Level */}
                <div className="card">
                  <div className="card-title">
                    <AlertTriangle width={16} height={16} /> Risk Level
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <select
                      className="form-select"
                      value={form.risk_level}
                      onChange={e => setForm(f => f ? { ...f, risk_level: e.target.value as 'low' | 'high' } : f)}
                      disabled={!isEditing}
                      style={{
                        fontWeight: 600,
                        color: form.risk_level === 'high' ? 'var(--red)' : 'var(--green)',
                        background: form.risk_level === 'high' ? 'rgba(239,68,68,0.05)' : 'rgba(34,197,94,0.05)',
                        borderColor: form.risk_level === 'high' ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.25)',
                        marginBottom: 10,
                      }}
                    >
                      <option value="low">Low Risk</option>
                      <option value="high">High Risk</option>
                    </select>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                      {form.risk_level === 'high'
                        ? 'High-risk tools can modify files or execute system code. Blocked during dry runs.'
                        : 'Low-risk tools primarily perform passive searches or read data.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Right col — JSON schema, always visible */}
              <div className="card" style={{ height: '100%' }}>
                <div className="card-title"><Code2 width={16} height={16} /> Input Schema</div>

                {selected.schema ? (
                  <>
                    <SchemaViewer schema={selected.schema as Record<string, unknown>} />
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Raw JSON
                      </div>
                      <pre style={{
                        background: 'var(--bg-base)', border: '1px solid var(--border)',
                        borderRadius: 8, padding: '12px 14px', fontSize: 11,
                        fontFamily: 'monospace', color: '#0c8d00ff',
                        overflowX: 'auto', whiteSpace: 'pre', margin: 0,
                      }}>
                        {JSON.stringify(selected.schema, null, 2)}
                      </pre>
                    </div>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No schema available.</span>
                )}
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}
