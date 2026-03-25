'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2, Trash2, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Clock, Bot, Timer, RefreshCw,
  BarChart3, Zap, History, Filter,
} from 'lucide-react';
import { taskRunsApi, type TaskRunRow, type AgentRunRow } from '@/lib/api';

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
      borderRadius: 100, fontSize: 11, fontWeight: 600,
      color: s.color, background: s.bg,
    }}>
      {s.icon} {status}
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

// ─── Agent sub-run row ────────────────────────────────────────────────────────
function AgentRunRow({ run: ar, idx }: { run: AgentRunRow; idx: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-elevated)' }}>
      <button
        type="button"
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{
          width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)',
          color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{idx + 1}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {ar.agent_name ?? 'Unknown Agent'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
            {fmtDuration(ar.duration_seconds)}
          </div>
        </div>
        <StatusBadge status={ar.status} />
        {open
          ? <ChevronDown width={14} height={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          : <ChevronRight width={14} height={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        }
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {ar.input_data?.prompt && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Instructions</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{ar.input_data.prompt}</div>
            </div>
          )}
          {ar.output_data?.text && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Output</div>
              <div style={{
                fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.7,
                whiteSpace: 'pre-wrap', maxHeight: 280, overflowY: 'auto',
                background: 'var(--bg-subtle)', borderRadius: 6, padding: '10px 12px',
              }}>{ar.output_data.text}</div>
            </div>
          )}
          {ar.error_message && (
            <div style={{ color: 'var(--red)', fontSize: 12 }}>⚠ {ar.error_message}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Run detail drawer ────────────────────────────────────────────────────────
function RunDrawer({ runId, onClose, onDelete }: { runId: string; onClose: () => void; onDelete: () => void }) {
  const [run, setRun]     = useState<TaskRunRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    taskRunsApi.get(runId).then(r => { setRun(r); setLoading(false); });
  }, [runId]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 500,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
      display: 'flex', justifyContent: 'flex-end',
    }} onClick={onClose}>
      <div style={{
        width: 600, height: '100%', background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border)', overflowY: 'auto',
        display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>

        {/* Drawer header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{run?.task_name ?? 'Run Details'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>{runId}</div>
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
              <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Bot width={12} height={12} /> {run.agent_runs?.length ?? 0} agents
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{timeAgo(run.started_at)}</span>
            </div>
          )}
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Loader2 width={24} height={24} className="spin" /></div>
        ) : run && (
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto' }}>

            {/* Prompt */}
            {run.input_data?.initialPrompt && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Initial Prompt</div>
                <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {run.input_data.initialPrompt}
                </div>
              </div>
            )}

            {/* Agent runs */}
            {run.agent_runs && run.agent_runs.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Agent Runs ({run.agent_runs.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {run.agent_runs.map((ar, i) => <AgentRunRow key={ar.id} run={ar} idx={i} />)}
                </div>
              </div>
            )}

            {/* Final output */}
            {run.output_data?.text && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Final Output</div>
                <div style={{
                  background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8,
                  padding: '14px 16px', fontSize: 13, color: 'var(--text-primary)',
                  lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 400, overflowY: 'auto',
                }}>{run.output_data.text}</div>
              </div>
            )}

            {/* Error */}
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

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const [runs, setRuns]         = useState<TaskRunRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const load = useCallback(async () => {
    const r = await taskRunsApi.list();
    setRuns(r);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this run and all its sub-runs?')) return;
    await taskRunsApi.delete(id);
    setRuns(r => r.filter(x => x.id !== id));
    if (detailId === id) setDetailId(null);
  };

  const filtered = runs.filter(r => statusFilter === 'all' || r.status === statusFilter);

  // Summary stats
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
          <div className="page-subtitle">Complete log of all task executions — click any row for full agent-level details</div>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={load}>
          <RefreshCw width={14} height={14} /> Refresh
        </button>
      </div>

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {[
          { label: 'Total Runs',   value: total,     color: 'var(--text-primary)', icon: <BarChart3 width={16} height={16} /> },
          { label: 'Completed',    value: completed, color: 'var(--green)',         icon: <CheckCircle2 width={16} height={16} /> },
          { label: 'Failed',       value: failed,    color: 'var(--red)',           icon: <XCircle width={16} height={16} /> },
          { label: 'Running Now',  value: running,   color: 'var(--accent-hover)',  icon: <Zap width={16} height={16} /> },
        ].map(s => (
          <div key={s.label} style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 12, padding: '16px 20px',
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <div style={{ color: s.color, opacity: 0.85 }}>{s.icon}</div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Filter width={14} height={14} style={{ color: 'var(--text-muted)' }} />
        {['all', 'completed', 'failed', 'running', 'pending'].map(s => (
          <button
            key={s}
            type="button"
            style={{
              fontSize: 12, padding: '4px 12px', borderRadius: 20,
              border: `1px solid ${statusFilter === s ? 'var(--accent)' : 'var(--border)'}`,
              background: statusFilter === s ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg-elevated)',
              color: statusFilter === s ? 'var(--accent-hover)' : 'var(--text-secondary)',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
            onClick={() => setStatusFilter(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Runs table */}
      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 70px 80px 100px 36px',
          padding: '10px 20px', background: 'var(--bg-subtle)',
          borderBottom: '1px solid var(--border)',
          fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em', gap: 12,
        }}>
          <span>Task</span><span>Status</span><span>Agents</span><span>Duration</span><span>Started</span><span />
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader2 width={22} height={22} className="spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: '60px 20px' }}>
            <History width={40} height={40} />
            <p>No runs yet{statusFilter !== 'all' ? ` with status "${statusFilter}"` : ''}.<br />Go to <strong>Task Runs</strong> to start a run.</p>
          </div>
        ) : (
          filtered.map(run => (
            <div
              key={run.id}
              style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 70px 80px 100px 36px',
                padding: '13px 20px', borderBottom: '1px solid var(--border)',
                alignItems: 'center', gap: 12, cursor: 'pointer', transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={() => setDetailId(run.id)}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {run.task_name ?? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Unknown task</span>}
                </div>
                {run.input_data?.initialPrompt && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {run.input_data.initialPrompt}
                  </div>
                )}
              </div>
              <StatusBadge status={run.status} />
              <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Bot width={12} height={12} /> {run.agent_runs_count ?? 0}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Timer width={12} height={12} /> {fmtDuration(run.duration_seconds)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(run.started_at)}</div>
              <button
                className="btn-icon"
                style={{ padding: 6 }}
                onClick={e => { e.stopPropagation(); handleDelete(run.id); }}
                title="Delete run"
              >
                <Trash2 width={13} height={13} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Detail drawer */}
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
