'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Wrench, Settings, ShieldAlert, FolderOpen, Loader2, X, 
  ChevronRight, ChevronDown, ShieldCheck, Zap, Search, Globe, Terminal, FileCode
} from 'lucide-react';
import { toolsApi, fsApi, settingsApi, type ToolRow, type FsBrowseResult } from '@/lib/api';

// ─── Directory Picker Modal ────────────────────────────────────────────────────
function DirPicker({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) {
  const [browse, setBrowse] = useState<FsBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);

  const go = async (path: string) => {
    setLoading(true);
    try {
      setBrowse(await fsApi.browse(path));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fsApi.home().then(h => go(h.home)).catch(() => go('C:\\'));
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 24, width: 480, maxHeight: '70vh',
        display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>📁 Choose Root Directory</span>
          <button className="btn-icon" onClick={onClose}><X width={15} height={15} /></button>
        </div>
        <div style={{
          background: 'var(--bg-elevated)', borderRadius: 6, padding: '6px 10px',
          fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all', fontFamily: 'monospace'
        }}>
          {browse?.current || '…'}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
              <Loader2 width={20} height={20} className="spin" />
            </div>
          ) : (
            <>
              {browse?.parent && (
                <button className="nav-item" style={{ fontWeight: 400, fontSize: 13, gap: 8 }} onClick={() => go(browse.parent!)}>
                   .. (Up)
                </button>
              )}
              {browse?.children.map(child => (
                <button key={child.path} className="nav-item" style={{ justifyContent: 'flex-start', gap: 8, fontWeight: 400, fontSize: 13 }} onClick={() => go(child.path)}>
                   <FolderOpen width={14} height={14} style={{ color: 'var(--accent-hover)', flexShrink: 0 }} /> {child.name}
                </button>
              ))}
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { if (browse) onSelect(browse.current); onClose(); }}>
            Select Sandbox Root
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [selected, setSelected] = useState<ToolRow | null>(null);
  const [rootDir, setRootDir] = useState<string>('');
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ts, st] = await Promise.all([toolsApi.list(), settingsApi.get()]);
      setTools(ts);
      if (st.root_directory) setRootDir(JSON.parse(st.root_directory));
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

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
  
  const groupIcons: Record<string, any> = {
    'Web Operations': <Globe width={12} height={12} />,
    'System Operations': <Terminal width={12} height={12} />,
    'File Operations': <FileCode width={12} height={12} />,
  };

  const groups = Object.keys(groupsRaw).sort((a,b) => {
    const order: Record<string, number> = { 'Web Operations': 1, 'File Operations': 2, 'System Operations': 3 };
    return (order[a] || 99) - (order[b] || 99);
  });

  const toggleGroup = (g: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  };

  const toggleEnable = async (id: string, current: boolean) => {
    await toolsApi.update(id, { is_enabled: !current });
    load();
  };

  const updateTool = async (id: string, patch: Partial<{ is_enabled: boolean, description: string, risk_level: 'low' | 'high' }>) => {
    setSelected(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
    setTools(ts => ts.map(t => t.id === id ? { ...t, ...patch } : t));
    await toolsApi.update(id, patch);
  };

  const [saving, setSaving] = useState(false);
  const saveAll = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await updateTool(selected.id, { 
        is_enabled: selected.is_enabled, 
        description: selected.description, 
        risk_level: selected.risk_level 
      });
    } finally {
      setSaving(false);
    }
  };

  const updateRootDir = async (path: string) => {
    setRootDir(path);
    await settingsApi.set('root_directory', JSON.stringify(path));
  };

  const showForm = showGlobalSettings || selected !== null;

  return (
    <div className="two-panel">
      {pickerOpen && <DirPicker onClose={() => setPickerOpen(false)} onSelect={updateRootDir} />}

      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Tools</h2>
          <button 
            className={`btn-icon ${showGlobalSettings ? 'active' : ''}`} 
            onClick={() => { setShowGlobalSettings(!showGlobalSettings); setSelected(null); }}
            title="Global Settings"
            style={{ color: showGlobalSettings ? 'var(--accent)' : 'inherit' }}
          >
            <Settings width={15} height={15} />
          </button>
        </div>

        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search tools or groups…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="list-scroll">
          {groups.map(g => {
             const isCollapsed = collapsedGroups.has(g);
             return (
              <div key={g}>
                <div 
                  onClick={(e) => toggleGroup(g, e)}
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
                >
                  {isCollapsed ? <ChevronRight width={12} height={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown width={12} height={12} style={{ color: 'var(--text-muted)' }} />}
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {groupIcons[g]} {g}
                  </span>
                  <span style={{ fontSize: 9, opacity: 0.5, fontWeight: 600 }}>{groupsRaw[g].length}</span>
                </div>
                {!isCollapsed && groupsRaw[g].map(tool => (
                  <div
                    key={tool.id}
                    className={`list-item ${selected?.id === tool.id ? 'selected' : ''}`}
                    onClick={() => { setSelected(tool); setShowGlobalSettings(false); }}
                  >
                    <div className="list-item-name">{tool.name}</div>
                    <div className="list-item-meta">{tool.risk_level.toUpperCase()} RISK · {tool.is_enabled ? 'ENABLED' : 'DISABLED'}</div>
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
            <Wrench width={48} height={48} />
            <p>Select a tool from the sidebar to edit,<br/>or click <Settings width={14} height={14} style={{ display: 'inline', opacity: 0.7 }}/> for global settings.</p>
          </div>
        ) : showGlobalSettings ? (
          <div style={{ maxWidth: 800 }}>
             <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <div className="page-title">Global Tool Settings</div>
             </div>
            <div className="page-subtitle">Configure sandboxing and system-wide security policies.</div>
            
            <div className="card">
              <div className="card-title"><FolderOpen width={16} height={16} /> Sandbox Configuration</div>
              <div className="form-group">
                <label className="form-label">Root Directory</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input readOnly className="form-input" value={rootDir || 'Documents (default)'} style={{ flex: 1 }} />
                  <button className="btn btn-ghost" onClick={() => setPickerOpen(true)}>Browse</button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  All file-system tools are strictly confined to this path. Traversal attempts (e.g. ../) will be blocked.
                </p>
              </div>
            </div>

            <div className="card">
              <div className="card-title" style={{ color: 'var(--red)' }}><ShieldAlert width={16} height={16} /> Security Policies</div>
              <ul style={{ fontSize: 13, color: 'var(--text-secondary)', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <li><strong>High Risk Policy:</strong> Tools tagged as "High Risk" are automatically disabled during Dry Runs.</li>
                <li><strong>Command Filtering:</strong> The Bash tool permanently blocks destructive verbs (rm, sudo, etc.).</li>
                <li><strong>Output Safety:</strong> All tool results are truncated to protect LLM context windows.</li>
              </ul>
            </div>
          </div>
        ) : selected && (
          <div style={{ maxWidth: 800 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
              <div>
                <div className="page-title">{selected.name}</div>
                <div className="page-subtitle">{selected.tool_group} capability</div>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                 <button className="btn btn-primary" onClick={saveAll} disabled={saving} style={{ padding: '6px 14px', fontSize: 13 }}>
                   {saving ? <span className="spinner" /> : <ShieldCheck width={14} height={14} />} {saving ? 'Saving...' : 'Save Changes'}
                 </button>
                 <div className="toggle-wrap">
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{selected.is_enabled ? 'Active' : 'Disabled'}</span>
                    <label className="toggle">
                        <input type="checkbox" checked={selected.is_enabled} onChange={() => updateTool(selected.id, { is_enabled: !selected.is_enabled })} />
                        <span className="toggle-track" />
                    </label>
                 </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Description</div>
              <textarea 
                className="form-textarea" 
                value={selected.description}
                onChange={(e) => setSelected({ ...selected, description: e.target.value })}
                style={{ fontSize: 14, minHeight: 120, background: 'var(--bg-base)' }}
              />
            </div>

            <div className="card">
               <div className="card-title">Capability Risk Level</div>
               <div className="form-group" style={{ marginBottom: 0 }}>
                  <select 
                    className="form-select"
                    value={selected.risk_level}
                    onChange={(e) => updateTool(selected.id, { risk_level: e.target.value as 'low' | 'high' })}
                    style={{ 
                        maxWidth: 200, 
                        fontWeight: 600,
                        color: selected.risk_level === 'high' ? 'var(--red)' : 'var(--green)',
                        background: selected.risk_level === 'high' ? 'rgba(239, 68, 68, 0.05)' : 'rgba(34, 197, 94, 0.05)',
                        borderColor: selected.risk_level === 'high' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(34, 197, 94, 0.2)'
                    }}
                  >
                    <option value="low">Low Risk</option>
                    <option value="high">High Risk</option>
                  </select>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
                    {selected.risk_level === 'high' 
                      ? 'High-risk tools can modify files or execute system code and are blocked during dry runs.' 
                      : 'Low-risk tools primarily perform passive searches or read data.'}
                  </p>
               </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
