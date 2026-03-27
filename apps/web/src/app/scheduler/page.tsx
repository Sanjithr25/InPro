'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Plus, Trash2, Pencil, Play, 
  Clock, CheckCircle2, XCircle, Loader2, Calendar,
  RefreshCw, ChevronRight, Timer, Zap, AlarmClock,
  Search, ToggleRight, ToggleLeft, ChevronDown, Save, X,
  Power,
} from 'lucide-react';
import { schedulesApi, tasksApi, type ScheduleRow, type TaskRow, type TriggerConfig } from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STATUS_META: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
  completed: { color: 'var(--green)',        bg: 'rgba(34,197,94,0.12)',  icon: <CheckCircle2 width={12} height={12} /> },
  failed:    { color: 'var(--red)',          bg: 'rgba(239,68,68,0.12)', icon: <XCircle width={12} height={12} /> },
  running:   { color: 'var(--accent-hover)', bg: 'var(--accent-dim)',    icon: <Loader2 width={12} height={12} className="spin" /> },
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const s = STATUS_META[status];
  if (!s) return null;
  return (
    <span className="badge" style={{ color: s.color, background: s.bg }}>
      {s.icon} {status}
    </span>
  );
}

function timeAgo(iso: string | null) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeUntil(iso: string | null) {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

function triggerLabel(row: ScheduleRow) {
  if (row.trigger_type === 'cron')     return row.trigger_config.cron ?? 'cron';
  if (row.trigger_type === 'interval') return `Every ${row.trigger_config.intervalMinutes}m`;
  if (row.trigger_type === 'one_time') return `Once at ${row.trigger_config.runAt ? new Date(row.trigger_config.runAt).toLocaleString() : '?'}`;
  return row.trigger_type;
}

// ─── Cron Presets ─────────────────────────────────────────────────────────────
const CRON_PRESETS = [
  { label: 'Every 5m', value: '*/5 * * * *' },
  { label: 'Every 15m', value: '*/15 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily (9AM)', value: '0 9 * * *' },
  { label: 'Nightly (Midnight)', value: '0 0 * * *' },
  { label: 'Weekly (Mon 9AM)', value: '0 9 * * 1' },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type FormState = {
  name: string;
  trigger_type: 'cron' | 'interval' | 'one_time' | 'manual';
  cron: string;
  intervalMinutes: string;
  runAt: string;
  is_enabled: boolean;
  task_ids: string[];
};

const EMPTY_FORM: FormState = {
  name: '', trigger_type: 'cron', cron: '0 9 * * *',
  intervalMinutes: '60', runAt: '', is_enabled: true, task_ids: [],
};

function fromRow(row: ScheduleRow): FormState {
  return {
    name: row.name,
    trigger_type: row.trigger_type as FormState['trigger_type'],
    cron: row.trigger_config.cron ?? '0 9 * * *',
    intervalMinutes: String(row.trigger_config.intervalMinutes ?? 60),
    runAt: row.trigger_config.runAt ?? '',
    is_enabled: row.is_enabled,
    task_ids: (row.tasks ?? []).map(t => t.id),
  };
}

function toPayload(f: FormState) {
  const trigger_config: TriggerConfig = {};
  if (f.trigger_type === 'cron')     trigger_config.cron = f.cron;
  if (f.trigger_type === 'interval') trigger_config.intervalMinutes = parseInt(f.intervalMinutes, 10);
  if (f.trigger_type === 'one_time') trigger_config.runAt = f.runAt;
  return { name: f.name, trigger_type: f.trigger_type, trigger_config, is_enabled: f.is_enabled, task_ids: f.task_ids };
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function SchedulerPage() {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [tasks, setTasks]         = useState<TaskRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState<ScheduleRow | null>(null);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [search, setSearch]       = useState('');

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([schedulesApi.list(), tasksApi.list()]);
      setSchedules(s);
      setTasks(t);
      if (selected) {
        const updated = s.find(x => x.id === selected.id);
        if (updated) setSelected(updated);
      }
    } catch (e) {
      console.warn('Failed to refresh schedules', e);
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), 5000); // Poll every 5s
    return () => clearInterval(timer);
  }, [load]);

  const openCreate = () => { setSelected(null); setForm(EMPTY_FORM); setShowForm(true); };
  const openEdit   = (row: ScheduleRow) => { setSelected(row); setForm(fromRow(row)); setShowForm(true); };
  const closeForm  = () => { setShowForm(false); setSelected(null); };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = toPayload(form);
      if (selected) {
        await schedulesApi.update(selected.id, payload);
      } else {
        await schedulesApi.create(payload);
      }
      await load();
      closeForm();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this schedule?')) return;
    await schedulesApi.delete(id);
    setSchedules(s => s.filter(x => x.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const handleToggle = async (id: string) => {
    const { is_enabled } = await schedulesApi.toggle(id);
    setSchedules(s => s.map(x => x.id === id ? { ...x, is_enabled } : x));
    if (selected?.id === id) setSelected(s => s ? { ...s, is_enabled } : null);
  };

  const handleRun = async (id: string) => {
    setRunningId(id);
    setSchedules(s => s.map(x => x.id === id ? { ...x, last_run_status: 'running' } : x));
    try {
      await schedulesApi.run(id);
      setTimeout(load, 1000);
    } catch (e: any) {
      alert(`Manual run failed: ${e.message}`);
    } finally {
      setRunningId(null);
    }
  };

  const filtered = schedules.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.trigger_type.toLowerCase().includes(search.toLowerCase())
  );

  const runningCount = schedules.filter(s => s.last_run_status === 'running').length;

  return (
    <div className="two-panel">
      {/* ── Sidebar ── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Schedules</h2>
          <button className="btn-icon" onClick={openCreate} title="New schedule">
            <Plus width={15} height={15} />
          </button>
        </div>

        <div className="search-wrap">
          <div style={{ position: 'relative' }}>
            <Search width={13} height={13} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }} />
            <input
              className="search-input"
              style={{ paddingLeft: 30 }}
              placeholder="Search schedules…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 14px 8px', display: 'flex', gap: 8 }}>
            <span>{filtered.length} total</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ color: runningCount > 0 ? 'var(--accent-hover)' : 'inherit' }}>{runningCount} running</span>
        </div>

        <div className="list-scroll">
          {loading ? (
             <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
               <Loader2 width={20} height={20} className="spin" />
             </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <AlarmClock width={32} height={32} />
              <p>No schedules found.</p>
            </div>
          ) : filtered.map(row => (
            <div
              key={row.id}
              className={`list-item${selected?.id === row.id ? ' selected' : ''}`}
              onClick={() => { setSelected(row); setShowForm(false); }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span className="list-item-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {row.name}
                </span>
                <span style={{ 
                    fontSize: 10, 
                    fontWeight: 700, 
                    color: row.is_enabled ? 'var(--green)' : 'var(--text-muted)',
                    opacity: row.is_enabled ? 1 : 0.6 
                }}>
                  {row.is_enabled ? 'ACTIVE' : 'PAUSED'}
                </span>
              </div>
              <div className="list-item-meta" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{triggerLabel(row)}</span>
                {row.last_run_status === 'running' && (
                  <span style={{ color: 'var(--accent-hover)', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Loader2 width={10} height={10} className="spin" />
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main Content ── */}
      <div className="panel-right" style={{ padding: '32px 48px' }}>
        {!showForm && !selected && (
          <div className="empty-state" style={{ height: '100%' }}>
            <Calendar width={48} height={48} />
            <p>Select a schedule to manage triggers,<br />or click <strong>+</strong> to automate a task.</p>
            <button className="btn btn-primary" onClick={openCreate}><Plus width={14} height={14} /> New Schedule</button>
          </div>
        )}

        {showForm && (
          <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div className="page-title">{selected ? 'Edit Schedule' : 'New Schedule'}</div>
                <div className="page-subtitle">{selected ? `Updating automation for "${selected.name}"` : 'Configure time-based or interval triggers'}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                 <button className="btn btn-ghost" onClick={closeForm}><X width={14} height={14} /> Cancel</button>
                 <button className="btn btn-primary" onClick={handleSave} disabled={saving || !form.name.trim()}>
                    {saving ? <span className="spinner" /> : <Save width={14} height={14} />}
                    {saving ? 'Saving…' : 'Save'}
                 </button>
              </div>
            </div>

            <div className="card">
              <div className="card-title"><AlarmClock width={16} height={16} /> Identity</div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Schedule Name</label>
                <input className="form-input" placeholder="e.g. Daily SEO Research" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
            </div>

            <div className="card">
              <div className="card-title"><Timer width={16} height={16} /> Trigger Configuration</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
                 {(['cron', 'interval', 'one_time', 'manual'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      className={`type-pill ${form.trigger_type === t ? 'select' : ''}`}
                      style={{ padding: '6px 14px', height: 'auto', flex: 1, textAlign: 'center' }}
                      onClick={() => setForm(f => ({ ...f, trigger_type: t }))}
                    >
                      {t === 'one_time' ? 'One-time' : t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                 ))}
              </div>

              {form.trigger_type === 'cron' && (
                <div className="form-group">
                  <label className="form-label">Cron Expression</label>
                  <input className="form-input" style={{ fontFamily: 'monospace' }} placeholder="e.g. 0 9 * * *" value={form.cron} onChange={e => setForm(f => ({ ...f, cron: e.target.value }))} />
                  
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>Quick Select</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                       {CRON_PRESETS.map(p => (
                         <button 
                            key={p.label} 
                            type="button" 
                            className="tool-chip"
                            style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => setForm(f => ({ ...f, cron: p.value }))}
                         >
                           {p.label}
                         </button>
                       ))}
                    </div>
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>Minute Hour Day Month Weekday (5 fields)</p>
                </div>
              )}
              {form.trigger_type === 'interval' && (
                <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Every</span>
                  <input className="form-input" style={{ width: 80 }} type="number" value={form.intervalMinutes} onChange={e => setForm(f => ({ ...f, intervalMinutes: e.target.value }))} />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>minutes</span>
                </div>
              )}
              {form.trigger_type === 'one_time' && (
                <div className="form-group">
                  <label className="form-label">Execution Time</label>
                  <input className="form-input" type="datetime-local" value={form.runAt} onChange={e => setForm(f => ({ ...f, runAt: e.target.value }))} />
                </div>
              )}
              {form.trigger_type === 'manual' && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>This schedule will only run when you manually click "Run Now".</p>
              )}
            </div>

            <div className="card">
              <div className="card-title"><Zap width={16} height={16} /> Target Tasks</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>Select tasks to execute in order. Items are chained sequentially.</p>
              {tasks.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No tasks available. Create one first.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {tasks.map(t => {
                    const idx = form.task_ids.indexOf(t.id);
                    const sel = idx !== -1;
                    return (
                      <div
                        key={t.id}
                        className={`tool-chip ${sel ? 'selected' : ''}`}
                        onClick={() => setForm(f => ({
                          ...f,
                          task_ids: sel ? f.task_ids.filter(x => x !== t.id) : [...f.task_ids, t.id]
                        }))}
                      >
                        {sel && <span style={{ marginRight: 6, fontWeight: 800 }}>{idx + 1}</span>}
                        {t.name}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {!showForm && selected && (
           <div style={{ width: '100%' }}>
             <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
                <div>
                  <div className="page-title">{selected.name}</div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                     <StatusBadge status={selected.last_run_status} />
                     <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                       <Clock width={13} height={13} /> {timeAgo(selected.last_run_at)}
                     </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {/* Toggle Option */}
                  <button 
                    className={`btn ${selected.is_enabled ? 'btn-ghost' : 'btn-primary'}`} 
                    onClick={() => handleToggle(selected.id)}
                    title={selected.is_enabled ? 'Pause Schedule' : 'Activate Schedule'}
                    style={{ gap: 8 }}
                  >
                    <Power width={14} height={14} />
                    {selected.is_enabled ? 'Pause' : 'Activate'}
                  </button>
                  
                  <div style={{ height: 20, width: 1, background: 'var(--border)', margin: '0 4px' }} />

                  <button className="btn btn-ghost" onClick={() => openEdit(selected)}><Pencil width={14} height={14} /> Edit</button>
                  <button className="btn btn-primary" onClick={() => handleRun(selected.id)} disabled={runningId === selected.id || selected.last_run_status === 'running'}>
                     {runningId === selected.id ? <span className="spinner" /> : <Play width={14} height={14} />}
                     Run Now
                  </button>
                  <button className="btn btn-danger" onClick={() => handleDelete(selected.id)}><Trash2 width={14} height={14} /></button>
                </div>
             </div>

             <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: 24, borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 32 }}>
                   <div>
                      <div className="form-label">Next Run</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: selected.is_enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {selected.is_enabled ? (selected.next_run_at ? timeUntil(selected.next_run_at) : 'Computing...') : 'Schedule Disabled'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        {selected.next_run_at ? new Date(selected.next_run_at).toLocaleString() : '—'}
                      </div>
                   </div>
                   <div>
                      <div className="form-label">Trigger Logic</div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{triggerLabel(selected)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Type: {selected.trigger_type}</div>
                   </div>
                   <div>
                      <div className="form-label">Status</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: selected.is_enabled ? 'var(--green)' : 'var(--text-muted)' }} />
                        <span style={{ fontSize: 15, fontWeight: 600, color: selected.is_enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                            {selected.is_enabled ? 'Active' : 'Paused'}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Auto-refreshing polling</div>
                   </div>
                </div>

                <div style={{ padding: 24 }}>
                   <div className="card-title" style={{ fontSize: 13, marginBottom: 16 }}><Zap width={14} height={14} /> Execution Pipeline</div>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                     {(selected.tasks ?? []).length === 0 ? (
                       <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No tasks assigned.</p>
                     ) : selected.tasks.map((t, i) => (
                       <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
                          <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {i + 1}
                          </span>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</span>
                          {i < selected.tasks.length - 1 && <ChevronRight width={16} height={16} style={{ marginLeft: 'auto', color: 'var(--text-muted)', opacity: 0.5 }} />}
                       </div>
                     ))}
                   </div>
                </div>
             </div>
           </div>
        )}
      </div>
    </div>
  );
}
