'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Play, Loader2, Square, RefreshCw, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Clock, FileText, Zap,
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
function TaskCard({ task, lastRun, runningRunId, expanded, onToggleExpand, runDetails, onRun, onKill }: {
  task: TaskRow;
  lastRun?: TaskRunRow;
  runningRunId?: string;
  expanded: boolean;
  onToggleExpand: () => void;
  runDetails: TaskRunRow | null;
  onRun: () => void;
  onKill: () => void;
}) {
  const steps = task.step_count ?? 0;
  const isRunning = !!runningRunId;
  const hasRunData = lastRun || runningRunId;

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: isRunning ? '1px solid var(--accent)' : '1px solid var(--border)',
      borderRadius: 12,
      display: 'flex', flexDirection: 'column',
      transition: 'border-color 0.15s',
      overflow: 'hidden'
    }}>
      <div 
        style={{ padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 16, cursor: hasRunData ? 'pointer' : 'default' }}
        onClick={() => {
          if (hasRunData) onToggleExpand();
        }}
      >
        <div style={{ color: 'var(--text-muted)' }}>
           {hasRunData ? (expanded ? <ChevronDown width={18}/> : <ChevronRight width={18}/>) : <span style={{width: 18, display: 'inline-block'}}/>}
        </div>
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
            {lastRun && !isRunning && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Last: <StatusBadge status={lastRun.status} />
              </span>
            )}
            {isRunning && (
              <span style={{ fontSize: 11, color: 'var(--accent-hover)', display: 'flex', gap: 4, alignItems: 'center' }}>
                <Loader2 width={11} height={11} className="spin"/> Running
              </span>
            )}
          </div>
        </div>

        {/* Right: actions */}
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center', paddingLeft: 10 }} onClick={e => e.stopPropagation()}>
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
        </div>
      </div>

      {/* Expanded details */}
      {expanded && runDetails && (
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-surface)', padding: '16px 20px 16px 54px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Execution Process
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {((task.workflow_definition || [])).map((step, i) => {
              const ar = runDetails.agent_runs?.[i];
              const isLast = i === (task.workflow_definition?.length ?? 0) - 1;
              
              // Determine status and color
              let statusLabel = 'Waiting';
              let Icon = Clock;
              let iconColor = 'var(--text-muted)';
              let textColor = 'var(--text-muted)';
              
              if (ar) {
                if (ar.status === 'completed') {
                  statusLabel = 'Completed';
                  Icon = CheckCircle2;
                  iconColor = 'var(--green)';
                  textColor = 'var(--text-primary)';
                } else if (ar.status === 'failed') {
                  statusLabel = 'Failed';
                  Icon = XCircle;
                  iconColor = 'var(--red)';
                  textColor = 'var(--text-primary)';
                } else if (ar.status === 'running') {
                  statusLabel = 'Running';
                  Icon = Loader2;
                  iconColor = 'var(--accent)';
                  textColor = 'var(--text-primary)';
                }
              } else if (runDetails.status === 'running' && (runDetails.agent_runs?.length ?? 0) === i) {
                // If it's the next step and task is running, it might be about to start or "running" but not yet created?
                // Actually TaskNode creates it immediately. So if it's not there, it's definitely waiting.
              }

              return (
                <div key={i} style={{ display: 'flex', gap: 14, position: 'relative' }}>
                  {/* Timeline connector */}
                  {!isLast && (
                    <div style={{
                      position: 'absolute', left: 7, top: 20, bottom: -14,
                      width: 1, background: 'var(--border)', opacity: 0.5
                    }} />
                  )}

                  <div style={{ zIndex: 1, background: 'var(--bg-surface)', height: 16, display: 'flex', alignItems: 'center' }}>
                    <Icon width={16} height={16} color={iconColor} className={ar?.status === 'running' ? 'spin' : ''} />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: textColor, display: 'flex', alignItems: 'center', gap: 8 }}>
                      Step {i + 1}: {step.stepName}
                      {ar?.status === 'running' && (
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--accent)', background: 'var(--accent-dim)', padding: '1px 6px', borderRadius: 4 }}>
                          Running
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                      {ar?.duration_seconds != null && ar.status !== 'running' ? (
                        <span style={{ color: 'var(--text-muted)' }}>Finished in {ar.duration_seconds}s</span>
                      ) : ar?.status === 'running' ? (
                        <span>Agent is working...</span>
                      ) : (
                        <span>{step.description || 'Waiting for previous steps...'}</span>
                      )}
                    </div>
                    {ar?.error_message && (
                      <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, background: 'rgba(239,68,68,0.06)', padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.1)' }}>
                        {ar.error_message}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {runDetails.status === 'completed' && (
             <div style={{ marginTop: 20, padding: '10px 14px', background: 'rgba(34,197,94,0.08)', borderRadius: 8, fontSize: 12, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 8 }}>
               <CheckCircle2 width={14} height={14} /> 
               Task completed successfully. Full logs available in history.
             </div>
          )}
        </div>
      )}
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
  
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});
  const [runDetailsMap, setRunDetailsMap] = useState<Record<string, TaskRunRow>>({}); // taskId -> detailed run

  // ─── 1. Initial Load: Fetch tasks and their last runs ──────────────────────
  useEffect(() => {
    const loadInitial = async () => {
      try {
        const [tasksList, runsList] = await Promise.all([
          tasksApi.list(),
          taskRunsApi.list()
        ]);
        
        setTasks(tasksList);
        
        // Build lastRuns and activeRuns from initial data
        const newLastRuns: Record<string, TaskRunRow> = {};
        const newActiveRuns: Record<string, string> = {};
        
        for (const r of runsList as (TaskRunRow & { is_active?: boolean })[]) {
          if (!newLastRuns[r.task_id] || new Date(r.created_at) > new Date(newLastRuns[r.task_id].created_at)) {
            newLastRuns[r.task_id] = r;
          }
          if (r.status === 'running') {
            newActiveRuns[r.task_id] = r.id;
          }
        }
        
        setLastRuns(newLastRuns);
        setActiveRuns(newActiveRuns);
        setLoading(false);
      } catch (e) {
        console.error('Failed to load initial data', e);
        setLoading(false);
      }
    };
    
    loadInitial();
  }, []);

  // ─── 2. Polling Logic: Consolidated ─────────────────────────────────────────
  useEffect(() => {
    let timer: NodeJS.Timeout;

    const poll = async () => {
      try {
        // Sync the runs list
        const runs = await taskRunsApi.list();
        
        // Update lastRuns map & activeRuns map
        const newLastRuns: Record<string, TaskRunRow> = {};
        const newActiveRuns: Record<string, string> = {};
        
        for (const r of runs as (TaskRunRow & { is_active?: boolean })[]) {
          if (!newLastRuns[r.task_id] || new Date(r.created_at) > new Date(newLastRuns[r.task_id].created_at)) {
            newLastRuns[r.task_id] = r;
          }
          if (r.status === 'running') {
            newActiveRuns[r.task_id] = r.id;
          }
        }
        
        setLastRuns(newLastRuns);
        setActiveRuns(newActiveRuns);

        // Auto-expand any newly running tasks
        setExpandedTasks(prev => {
          let changed = false;
          const next = { ...prev };
          Object.keys(newActiveRuns).forEach(taskId => {
            if (!next[taskId]) {
              next[taskId] = true;
              changed = true;
            }
          });
          return changed ? next : prev;
        });

        // Schedule next poll: 3s if active, 8s if idle
        const hasActive = Object.keys(newActiveRuns).length > 0;
        timer = setTimeout(poll, hasActive ? 3000 : 8000);
      } catch (e) {
        console.warn('Polling hiccup', e);
        timer = setTimeout(poll, 8000); // Retry after 8s on error
      }
    };

    // Start polling after a short delay to avoid double-fetch with initial load
    timer = setTimeout(poll, 3000);
    return () => clearTimeout(timer);
  }, []); // No dependencies - runs once and self-schedules

  // ─── 3. Fetch details for expanded tasks ───────────────────────────────────
  useEffect(() => {
    const fetchDetails = async () => {
      const expandedIds = Object.entries(expandedTasks)
        .filter(([_, isExp]) => isExp)
        .map(([taskId, _]) => activeRuns[taskId] || lastRuns[taskId]?.id)
        .filter(Boolean) as string[];

      if (expandedIds.length === 0) return;

      const detailedResults = await Promise.all(
        expandedIds.map(id => taskRunsApi.get(id).catch(() => null))
      );
      
      setRunDetailsMap(prev => {
        const next = { ...prev };
        detailedResults.forEach(det => {
          if (det) next[det.task_id] = det;
        });
        return next;
      });
    };

    fetchDetails();
  }, [expandedTasks, activeRuns, lastRuns]);

  const handleRun = async (task: TaskRow, prompt: string) => {
    try {
      const { run_id } = await taskRunsApi.run(task.id, prompt);
      if (run_id) {
        setActiveRuns(prev => ({ ...prev, [task.id]: run_id }));
        setExpandedTasks(prev => ({ ...prev, [task.id]: true }));
        // Trigger an immediate check rather than waiting for next poll
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
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => window.location.reload()}>
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
      {loading && tasks.length === 0 ? (
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
              expanded={!!expandedTasks[task.id]}
              onToggleExpand={() => setExpandedTasks(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
              runDetails={runDetailsMap[task.id] || null}
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

