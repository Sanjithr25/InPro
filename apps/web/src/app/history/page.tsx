'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2, Trash2, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Clock, Bot, Timer, RefreshCw,
  BarChart3, Zap, History, Filter, Calendar, AlarmClock, Search, X,
} from 'lucide-react';
import { historyApi, type HistoryRunRow, type HistoryRunDetail } from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STATUS_META: Record<string, { color: string; bg: string; icon: React.ReactNode }> = {
  completed: { color: 'var(--green)',        bg: 'rgba(34,197,94,0.12)',  icon: <CheckCircle2 width={13} height={13} /> },
  failed:    { color: 'var(--red)',          bg: 'rgba(239,68,68,0.12)', icon: <XCircle width={13} height={13} /> },
  running:   { color: 'var(--accent-hover)', bg: 'var(--accent-dim)',    icon: <Loader2 width={13} height={13} className="spin" /> },
  pending:   { color: 'var(--yellow)',       bg: 'rgba(234,179,8,0.12)', icon: <Clock width={13} height={13} /> },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_META[status] ?? STATUS_META.pending;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
      borderRadius: 100, fontSize: 11, fontWeight: 600, color: s.color, background: s.bg,
    }}>{s.icon} {status}</span>
  );
}

function TypeBadge({ type }: { type: 'task' | 'schedule' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
      borderRadius: 6, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
      color: type === 'schedule' ? 'var(--accent-hover)' : 'var(--text-muted)',
      background: type === 'schedule' ? 'var(--accent-dim)' : 'var(--bg-subtle)',
      border: '1px solid var(--border)',
    }}>
      {type === 'schedule' ? <AlarmClock width={10} height={10} /> : <Bot width={10} height={10} />}
      {type}
    </span>
  );
}

function fmtDuration(secs: number | null) {
  if (secs === null || secs < 0) return '—';
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
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

// ─── Detail Drawer ────────────────────────────────────────────────────────────
function RunDrawer({ runId, onClose, onDelete }: { runId: string; onClose: () => void; onDelete: () => void }) {
  const [run, setRun]     = useState<HistoryRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamingOutput, setStreamingOutput] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    
    const loadRun = async () => {
      const r = await historyApi.get(runId);
      setRun(r);
      setLoading(false);
      
      // If run is still running, start streaming
      if (r.status === 'running') {
        setIsStreaming(true);
        eventSource = new EventSource(`http://localhost:3001/api/history/${runId}/stream`);
        
        eventSource.addEventListener('connected', () => {
          console.log('Stream connected');
        });
        
        eventSource.addEventListener('status', (e) => {
          const data = JSON.parse(e.data);
          setRun(prev => prev ? { ...prev, status: data.status } : null);
        });
        
        eventSource.addEventListener('output', (e) => {
          const data = JSON.parse(e.data);
          if (data.text) {
            setStreamingOutput(data.text);
          }
        });
        
        eventSource.addEventListener('done', () => {
          setIsStreaming(false);
          eventSource?.close();
          // Reload full run data
          historyApi.get(runId).then(r => setRun(r));
        });
        
        eventSource.addEventListener('error', (e) => {
          console.error('Stream error:', e);
          setIsStreaming(false);
          eventSource?.close();
        });
      }
    };
    
    loadRun();
    
    return () => {
      eventSource?.close();
    };
  }, [runId]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 500,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
      display: 'flex', justifyContent: 'flex-end',
    }} onClick={onClose}>
      <div style={{
        width: 620, height: '100%', background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border)', overflowY: 'auto',
        display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>

        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                {run && <TypeBadge type={run.node_type} />}
                <div style={{ fontSize: 16, fontWeight: 700 }}>{run?.source_name ?? 'Run Details'}</div>
                {isStreaming && (
                  <span style={{ 
                    fontSize: 10, 
                    padding: '2px 8px', 
                    borderRadius: 4, 
                    background: 'var(--accent-dim)', 
                    color: 'var(--accent-hover)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4
                  }}>
                    <Loader2 width={10} height={10} className="spin" /> LIVE
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{runId}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-danger" style={{ fontSize: 12, padding: '5px 12px' }}
                onClick={() => { onDelete(); onClose(); }}>
                <Trash2 width={12} height={12} /> Delete
              </button>
              <button className="btn-icon" onClick={onClose} style={{ fontSize: 18, fontWeight: 300 }}>✕</button>
            </div>
          </div>
          {run && (
            <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <StatusBadge status={run.status} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Timer width={12} height={12} /> {fmtDuration(run.duration_seconds)}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{timeAgo(run.started_at)}</span>
            </div>
          )}
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader2 width={24} height={24} className="spin" />
          </div>
        ) : run && (
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto' }}>

            {/* Streaming Output (for running tasks) */}
            {isStreaming && streamingOutput && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Loader2 width={12} height={12} className="spin" /> Live Output
                </div>
                <div style={{
                  background: 'var(--bg-base)', border: '1px solid var(--accent)', borderRadius: 8,
                  padding: '14px 16px', fontSize: 13, color: 'var(--text-primary)',
                  lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 400, overflowY: 'auto',
                }}>
                  {streamingOutput}
                </div>
              </div>
            )}

            {/* Children (only for schedule runs, not task runs since tasks show pipeline) */}
            {run.children && run.children.length > 0 && run.node_type === 'schedule' && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Task Runs ({run.children.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {run.children.map((child, i) => (
                    <ChildRow key={child.id} child={child} idx={i} parentType={run.node_type} />
                  ))}
                </div>
              </div>
            )}

            {/* Output */}
            {run.output_data && (
              <div>
                {/* Task Pipeline Output */}
                {run.node_type === 'task' && (run.output_data as any).steps && Array.isArray((run.output_data as any).steps) && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Pipeline Execution ({((run.output_data as any).steps as Array<any>).length} steps)
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {((run.output_data as any).steps as Array<{ stepName: string; agentId: string; output: string; runId: string }>).map((step, idx) => {
                        // Find the corresponding child agent run for this step
                        const agentRun = run.children?.find(c => c.id === step.runId);
                        const toolsUsed = agentRun?.output_data ? (agentRun.output_data as any).toolsUsed : null;
                        
                        return (
                          <div key={idx} style={{
                            border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-elevated)'
                          }}>
                            <div style={{
                              padding: '10px 14px', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)',
                              display: 'flex', alignItems: 'center', gap: 10
                            }}>
                              <span style={{
                                width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)',
                                color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                              }}>{idx + 1}</span>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{step.stepName}</div>
                                {agentRun && (
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span>Agent: <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{(agentRun as any).agent_name || 'Unknown'}</span></span>
                                    {(agentRun as any).agent_group && (
                                      <span style={{ opacity: 0.7 }}>• {(agentRun as any).agent_group}</span>
                                    )}
                                  </div>
                                )}
                              </div>
                              {toolsUsed && Array.isArray(toolsUsed) && toolsUsed.length > 0 && (
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span style={{ fontWeight: 600 }}>{toolsUsed.length}</span> tool{toolsUsed.length !== 1 ? 's' : ''}
                                </div>
                              )}
                            </div>
                            <div style={{ padding: '12px 14px' }}>
                              {toolsUsed && Array.isArray(toolsUsed) && toolsUsed.length > 0 && (
                                <div style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {toolsUsed.map((tool: string, i: number) => (
                                    <span key={i} style={{
                                      fontSize: 10, padding: '2px 8px', borderRadius: 4,
                                      background: 'var(--bg-base)', border: '1px solid var(--border)',
                                      color: 'var(--text-secondary)', fontFamily: 'monospace'
                                    }}>
                                      {tool}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div style={{
                                fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                                maxHeight: 200, overflowY: 'auto', background: 'var(--bg-base)', borderRadius: 6,
                                padding: '10px 12px', border: '1px solid var(--border)'
                              }}>
                                {step.output}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Agent Output (non-task runs) */}
                {run.node_type !== 'task' && (run.output_data as any).text && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Output</div>
                    <div style={{
                      background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8,
                      padding: '14px 16px', fontSize: 13, color: 'var(--text-primary)',
                      lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 400, overflowY: 'auto',
                    }}>
                      {(run.output_data as any).text}
                    </div>
                  </div>
                )}
              </div>
            )}

            {run.error_message && (
              <div style={{
                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 8, padding: '12px 14px', color: 'var(--red)', fontSize: 13,
              }}>⚠ {run.error_message}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChildRow({ child, idx, parentType }: {
  child: HistoryRunDetail['children'][0];
  idx: number;
  parentType: 'task' | 'schedule';
}) {
  const [open, setOpen] = useState(false);
  const label = parentType === 'schedule'
    ? (child.task_name ?? 'Unknown Task')
    : (child.agent_name ?? 'Unknown Agent');

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-elevated)' }}>
      <button
        type="button"
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{
          width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)',
          color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{idx + 1}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{fmtDuration(child.duration_seconds)}</div>
        </div>
        <StatusBadge status={child.status} />
        {open ? <ChevronDown width={14} height={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight width={14} height={14} style={{ color: 'var(--text-muted)' }} />}
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {child.agent_group && (
             <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Bot width={12} height={12} /> Group: <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{child.agent_group}</span>
             </div>
          )}
          
          {(child.input_data as any)?.prompt && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
                {(child.input_data as any)?.stepName ? 'Step Instructions' : 'Instructions from Manager'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', background: 'rgba(0,0,0,0.02)', padding: '6px 8px', borderRadius: 4 }}>
                {(child.input_data as any).prompt}
              </div>
            </div>
          )}

          {(child.output_data as { text?: string })?.text && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>Response</div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto', background: 'var(--bg-subtle)', borderRadius: 6, padding: '10px 12px', border: '1px solid var(--border)' }}>
                {(child.output_data as { text: string }).text}
              </div>
            </div>
          )}
          {child.error_message && <div style={{ color: 'var(--red)', fontSize: 12, padding: '8px', background: 'rgba(239,68,68,0.05)', borderRadius: 4 }}>⚠ {child.error_message}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const [runs, setRuns]         = useState<HistoryRunRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter]     = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const r = await historyApi.list();
      setRuns(r);
      setLoading(false);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this run and all its sub-runs?')) return;
    await historyApi.delete(id);
    setRuns(r => r.filter(x => x.id !== id));
    if (detailId === id) setDetailId(null);
  };

  const filtered = runs.filter(r =>
    (statusFilter === 'all' || r.status === statusFilter) &&
    (typeFilter   === 'all' || r.node_type === typeFilter) &&
    (r.source_name?.toLowerCase().includes(searchQuery.toLowerCase()) || false)
  );

  const total     = runs.length;
  const completed = runs.filter(r => r.status === 'completed').length;
  const failed    = runs.filter(r => r.status === 'failed').length;
  const running   = runs.filter(r => r.status === 'running').length;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '32px 36px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">Run History</div>
          <div className="page-subtitle">All task and schedule executions — click any row for full details</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {/* Search Box */}
          <div style={{ position: 'relative' }}>
            <Search width={14} height={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search task or schedule…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                paddingLeft: 36,
                paddingRight: searchQuery ? 36 : 12,
                paddingTop: 8,
                paddingBottom: 8,
                width: 240,
                fontSize: 12,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text-primary)',
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  padding: 4,
                }}
              >
                <X width={14} height={14} />
              </button>
            )}
          </div>
          <button 
            className="btn btn-ghost" 
            style={{ fontSize: 13 }} 
            onClick={load}
            disabled={isRefreshing}
          >
            <RefreshCw 
              width={14} 
              height={14} 
              style={{ 
                transition: 'transform 0.6s ease-in-out',
                transform: isRefreshing ? 'rotate(360deg)' : 'rotate(0deg)',
              }} 
            /> 
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {[
          { label: 'Total Runs',  value: total,     color: 'var(--text-primary)', icon: <BarChart3 width={16} height={16} /> },
          { label: 'Completed',   value: completed, color: 'var(--green)',         icon: <CheckCircle2 width={16} height={16} /> },
          { label: 'Failed',      value: failed,    color: 'var(--red)',           icon: <XCircle width={16} height={16} /> },
          { label: 'Running Now', value: running,   color: 'var(--accent-hover)',  icon: <Zap width={16} height={16} /> },
        ].map(s => (
          <div key={s.label} className="card" style={{
            padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 0
          }}>
            <div style={{ color: s.color, opacity: 0.85 }}>{s.icon}</div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 0, alignItems: 'center', background: 'var(--bg-elevated)', borderRadius: 14, padding: 4, border: '1px solid var(--border)' }}>
          {['all', 'completed', 'failed', 'running'].map((s, idx) => (
            <button 
              key={s} 
              type="button" 
              style={{ 
                fontSize: 12, 
                padding: '6px 16px',
                fontWeight: 600,
                borderRadius: 10,
                border: 'none',
                background: statusFilter === s ? 'var(--bg-surface)' : 'transparent',
                color: statusFilter === s ? 'var(--text-primary)' : 'var(--text-muted)',
                transition: 'all 150ms ease',
                cursor: 'pointer',
                boxShadow: statusFilter === s ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
              onClick={() => setStatusFilter(s)}
              onMouseEnter={e => {
                if (statusFilter !== s) {
                  e.currentTarget.style.color = 'var(--text-primary)';
                }
              }}
              onMouseLeave={e => {
                if (statusFilter !== s) {
                  e.currentTarget.style.color = 'var(--text-muted)';
                }
              }}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 0, alignItems: 'center', background: 'var(--bg-elevated)', borderRadius: 14, padding: 4, border: '1px solid var(--border)' }}>
          {['all', 'task', 'schedule'].map((t, idx) => (
            <button 
              key={t} 
              type="button" 
              style={{ 
                fontSize: 12, 
                padding: '6px 16px',
                fontWeight: 600,
                borderRadius: 10,
                border: 'none',
                background: typeFilter === t ? 'var(--bg-surface)' : 'transparent',
                color: typeFilter === t ? 'var(--text-primary)' : 'var(--text-muted)',
                transition: 'all 150ms ease',
                cursor: 'pointer',
                boxShadow: typeFilter === t ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
              onClick={() => setTypeFilter(t)}
              onMouseEnter={e => {
                if (typeFilter !== t) {
                  e.currentTarget.style.color = 'var(--text-primary)';
                }
              }}
              onMouseLeave={e => {
                if (typeFilter !== t) {
                  e.currentTarget.style.color = 'var(--text-muted)';
                }
              }}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 80px 100px 90px 110px 36px',
          padding: '12px 20px', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)',
          fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', gap: 12,
        }}>
          <span>Source</span><span>Type</span><span>Status</span><span>Duration</span><span>Started</span><span />
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader2 width={22} height={22} className="spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: '60px 20px' }}>
            <History width={40} height={40} />
            <p>No runs yet. Go to <strong>Task Runs</strong> or <strong>Scheduler</strong> to start one.</p>
          </div>
        ) : (
          filtered.map(run => (
            <div
              key={run.id}
              style={{
                display: 'grid', gridTemplateColumns: '2fr 80px 100px 90px 110px 36px',
                padding: '14px 20px', borderBottom: '1px solid var(--border)',
                alignItems: 'center', gap: 12, cursor: 'pointer', transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={() => setDetailId(run.id)}
            >
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {run.source_name ?? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Manual Run</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {run.child_count} {run.node_type === 'schedule' ? 'task' : 'agent'}{run.child_count !== 1 ? 's' : ''}
                </div>
              </div>
              <TypeBadge type={run.node_type} />
              <div style={{ display: 'flex' }}>
                 <StatusBadge status={run.status} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Timer width={12} height={12} /> {fmtDuration(run.duration_seconds)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(run.started_at)}</div>
              <button
                className="btn-icon" style={{ padding: 6, background: 'none' }}
                onClick={e => { e.stopPropagation(); handleDelete(run.id); }}
                title="Delete run"
              >
                <Trash2 width={13} height={13} />
              </button>
            </div>
          ))
        )}
      </div>

      {detailId && (
        <RunDrawer
          runId={detailId}
          onClose={() => setDetailId(null)}
          onDelete={() => handleDelete(detailId)}
        />
      )}
    </div>
  );
}
