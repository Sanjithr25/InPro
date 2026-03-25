'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Play, Loader2, Square, RefreshCw, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Clock, Bot, FileText, Zap, Plus,
} from 'lucide-react';
import { tasksApi, taskRunsApi, type TaskRow, type TaskRunRow } from '@/lib/api';

// ─── Status badge ─────────────────────────────────────────────────────────────
const STATUS_META: Record<string, { color: string; bg: string; label: string }> = {
  completed: { color: 'var(--green)',        bg: 'rgba(34,197,94,0.12)',  label: 'Completed'  },
  failed:    { color: 'var(--red)',          bg: 'rgba(239,68,68,0.12)', label: 'Failed'     },
  running:   { color: 'var(--accent-hover)', bg: 'var(--accent-dim)',    label: 'Running'    },
  pending:   { color: 'var(--yellow)',       bg: 'rgba(234,179,8,0.12)', label: 'Pending'    },
};
function StatusBadge({ status }: { status: string }) {
  const s = STATUS_META[status] ?? STATUS_META.pending;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 100,
      fontSize: 11, fontWeight: 600,
      color: s.color, background: s.bg,
    }}>
      {status === 'running' && <Loader2 width={11} height={11} className="spin" />}
      {s.label}
    </span>
  );
}

// ─── Run prompt modal ─────────────────────────────────────────────────────────
function RunModal({ task, onClose, onRun }: {
  task: TaskRow;
  onClose: () => void;
  onRun: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const steps = task.step_count ?? 0;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 600, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 28, width: 500,
        display: 'flex', flexDirection: 'column', gap: 18,
        boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
      }} onClick={e => e.stopPropagation()}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>▶ Run — {task.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            {steps} step{steps !== 1 ? 's' : ''} · This run will be saved to Run History
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Initial Prompt <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <textarea
            className="form-textarea"
            rows={3}
            placeholder="e.g. Research AI in healthcare and write a summary blog post…"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            autoFocus
          />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onRun(prompt); onClose(); }}>
            <Play width={14} height={14} /> Start Run
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Task card ────────────────────────────────────────────────────────────────
function TaskCard({ task, lastRun, runningRunId, onRun, onKill }: {
  task: TaskRow;
  lastRun?: TaskRunRow;
  runningRunId?: string;
  onRun: () => void;
  onKill: () => void;
}) {
  const steps = task.step_count ?? 0;
  const isRunning = !!runningRunId;

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: isRunning ? '1px solid var(--accent)' : '1px solid var(--border)',
      borderRadius: 12, padding: '18px 20px',
      display: 'flex', alignItems: 'center', gap: 16,
      transition: 'border-color 0.15s',
    }}>
      {/* Left: task info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
          {task.name}
        </div>
        {task.description && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.description}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
            <Zap width={11} height={11} /> {steps} step{steps !== 1 ? 's' : ''}
          </span>
          {lastRun && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Last: <StatusBadge status={lastRun.status} />
            </span>
          )}
        </div>
      </div>

      {/* Right: actions */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
        {isRunning ? (
          <button
            className="btn"
            style={{ padding: '7px 14px', fontSize: 12, background: 'rgba(239,68,68,0.1)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)' }}
            onClick={onKill}
            title="Kill this run"
          >
            <Square width={13} height={13} /> Kill
          </button>
        ) : (
          <button
            className="btn btn-primary"
            style={{ padding: '7px 16px', fontSize: 12 }}
            onClick={onRun}
            disabled={steps === 0}
          >
            <Play width={13} height={13} /> Run
          </button>
        )}
        {isRunning && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--accent-hover)' }}>
            <Loader2 width={13} height={13} className="spin" /> Running…
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function TaskRunsPage() {
  const [tasks, setTasks]         = useState<TaskRow[]>([]);
  const [lastRuns, setLastRuns]   = useState<Record<string, TaskRunRow>>({});
  const [loading, setLoading]     = useState(true);
  const [runModal, setRunModal]   = useState<TaskRow | null>(null);
  const [activeRuns, setActiveRuns] = useState<Record<string, string>>({}); // taskId -> runId
  const [search, setSearch]       = useState('');

  const load = useCallback(async () => {
    try {
      const [t, runs] = await Promise.all([tasksApi.list(), taskRunsApi.list()]);
      setTasks(t);
      // Build map of most-recent run per task
      const map: Record<string, TaskRunRow> = {};
      for (const r of runs) {
        if (!map[r.task_id] || new Date(r.created_at) > new Date(map[r.task_id].created_at)) {
          map[r.task_id] = r;
        }
      }
      setLastRuns(map);
      // Sync active runs — remove from state if no longer "running" in DB
      setActiveRuns(prev => {
        const next = { ...prev };
        for (const [taskId, runId] of Object.entries(next)) {
          const run = runs.find(r => r.id === runId);
          if (!run || run.status !== 'running') delete next[taskId];
        }
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while anything is running
  useEffect(() => {
    if (Object.keys(activeRuns).length === 0) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [activeRuns, load]);

  const handleRun = async (task: TaskRow, prompt: string) => {
    try {
      const { run_id } = await taskRunsApi.run(task.id, prompt);
      if (run_id) {
        setActiveRuns(prev => ({ ...prev, [task.id]: run_id }));
        // Start polling
        load();
      }
    } catch (e: any) {
      alert(`Failed to start run: ${e.message}`);
    }
  };

  const handleKill = async (taskId: string) => {
    const runId = activeRuns[taskId];
    if (!runId) return;
    try {
      await taskRunsApi.kill(runId);
      setActiveRuns(prev => { const n = { ...prev }; delete n[taskId]; return n; });
      await load();
    } catch (e: any) {
      alert(`Kill failed: ${e.message}`);
    }
  };

  const filtered = tasks.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (t.description ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '32px 36px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">Task Runs</div>
          <div className="page-subtitle">Select a task and run it — results are saved to Run History</div>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={load}>
          <RefreshCw width={14} height={14} /> Refresh
        </button>
      </div>

      {/* Search */}
      <div className="search-wrap" style={{ maxWidth: 420 }}>
        <input
          className="search-input"
          placeholder="Search tasks…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Task list */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Loader2 width={28} height={28} className="spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <FileText width={40} height={40} />
          <p>No tasks found.<br />Create tasks in the <strong>Tasks</strong> page first.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              lastRun={lastRuns[task.id]}
              runningRunId={activeRuns[task.id]}
              onRun={() => setRunModal(task)}
              onKill={() => handleKill(task.id)}
            />
          ))}
        </div>
      )}

      {/* Run modal */}
      {runModal && (
        <RunModal
          task={runModal}
          onClose={() => setRunModal(null)}
          onRun={prompt => handleRun(runModal, prompt)}
        />
      )}
    </div>
  );
}
