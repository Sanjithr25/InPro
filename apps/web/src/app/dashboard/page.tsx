'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, CheckCircle2, XCircle, Clock, AlertTriangle,
  Play, Plus, History, ChevronRight,
} from 'lucide-react';
import { dashboardApi, tasksApi, type DashboardData } from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let timer: NodeJS.Timeout;

    const poll = async () => {
      try {
        const result = await dashboardApi.get();
        setData(result);
        setLoading(false);

        // Adaptive polling: 3s if active runs, 8s if idle
        const hasActive = result.health.active_runs > 0;
        timer = setTimeout(poll, hasActive ? 3000 : 8000);
      } catch (e) {
        console.error('Dashboard poll failed', e);
        timer = setTimeout(poll, 8000);
      }
    };

    poll();
    return () => clearTimeout(timer);
  }, []);

  if (loading || !data) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 width={32} height={32} className="spin" />
      </div>
    );
  }

  const { health, activity, failures, next_schedules } = data;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      
      {/* System Health Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <div style={{
          background: 'var(--bg-elevated)',
          border: health.active_runs > 0 ? '1px solid var(--accent)' : '1px solid var(--border)',
          borderRadius: 10,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            Active Runs
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: health.active_runs > 0 ? 'var(--accent-hover)' : 'var(--text-primary)' }}>
            {health.active_runs}
          </div>
        </div>

        <div style={{
          background: 'var(--bg-elevated)',
          border: health.failed_24h > 0 ? '1px solid var(--red)' : '1px solid var(--border)',
          borderRadius: 10,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            Failed (24h)
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: health.failed_24h > 0 ? 'var(--red)' : 'var(--text-primary)' }}>
            {health.failed_24h}
          </div>
        </div>

        <div style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            Enabled Schedules
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>
            {health.enabled_schedules}
          </div>
        </div>

        <div style={{
          background: 'var(--bg-elevated)',
          border: health.queue_status === 'healthy' ? '1px solid var(--border)' : '1px solid var(--yellow)',
          borderRadius: 10,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            Queue Status
          </div>
          <div style={{ 
            fontSize: 14, 
            fontWeight: 700, 
            color: health.queue_status === 'healthy' ? 'var(--green)' : 'var(--yellow)',
            textTransform: 'capitalize',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            {health.queue_status === 'healthy' ? <CheckCircle2 width={16} height={16} /> : <AlertTriangle width={16} height={16} />}
            {health.queue_status}
          </div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20, flex: 1, minHeight: 0 }}>
        
        {/* Live Activity Feed */}
        <div style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '18px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflow: 'hidden',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-primary)' }}>
            Live Activity
          </div>
          
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activity.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                No recent activity
              </div>
            ) : (
              activity.map(run => {
                const isRunning = run.status === 'running';
                const isFailed = run.status === 'failed';
                const isCompleted = run.status === 'completed';

                return (
                  <div
                    key={run.id}
                    style={{
                      padding: '10px 12px',
                      background: 'var(--bg-surface)',
                      border: isRunning ? '1px solid var(--accent)' : isFailed ? '1px solid var(--red)' : '1px solid var(--border)',
                      borderRadius: 8,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      transition: 'all 150ms ease',
                    }}
                    onClick={() => router.push('/history')}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'var(--bg-surface)'}
                  >
                    {isRunning && <Loader2 width={14} height={14} className="spin" style={{ color: 'var(--accent-hover)', flexShrink: 0 }} />}
                    {isFailed && <XCircle width={14} height={14} style={{ color: 'var(--red)', flexShrink: 0 }} />}
                    {isCompleted && <CheckCircle2 width={14} height={14} style={{ color: 'var(--green)', flexShrink: 0 }} />}
                    
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                        {run.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {isRunning && run.current_agent && `→ ${run.current_agent}`}
                        {isRunning && !run.current_agent && 'Starting...'}
                        {isFailed && 'Failed'}
                        {isCompleted && `Finished in ${formatDuration(run.duration_seconds)}`}
                      </div>
                    </div>

                    <div style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                      {isRunning ? `${run.duration_seconds}s` : timeAgo(run.ended_at)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Failures Panel */}
        <div style={{
          background: 'var(--bg-elevated)',
          border: failures.length > 0 ? '1px solid var(--red)' : '1px solid var(--border)',
          borderRadius: 12,
          padding: '18px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflow: 'hidden',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: failures.length > 0 ? 'var(--red)' : 'var(--text-primary)' }}>
            Recent Failures
          </div>
          
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {failures.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                No recent failures
              </div>
            ) : (
              failures.map(fail => (
                <div
                  key={fail.id}
                  style={{
                    padding: '10px 12px',
                    background: 'rgba(239,68,68,0.06)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    transition: 'all 150ms ease',
                  }}
                  onClick={() => router.push('/history')}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239,68,68,0.1)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(239,68,68,0.06)'}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>
                    {fail.name}
                  </div>
                  {fail.failed_agent && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                      Failed at: {fail.failed_agent}
                    </div>
                  )}
                  {fail.error_message && (
                    <div style={{ fontSize: 11, color: 'var(--red)', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {fail.error_message}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                    {timeAgo(fail.created_at)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Schedule Snapshot */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '18px 20px',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-primary)', marginBottom: 14 }}>
          Next Schedules
        </div>
        
        {next_schedules.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '10px 0', textAlign: 'center' }}>
            No enabled schedules
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            {next_schedules.map(sched => (
              <div
                key={sched.id}
                style={{
                  padding: '10px 12px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  transition: 'all 150ms ease',
                }}
                onClick={() => router.push('/scheduler')}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border)'}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                  {sched.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>
                  <Clock width={10} height={10} style={{ display: 'inline', marginRight: 4 }} />
                  {timeUntil(sched.next_run_at)}
                </div>
                {sched.last_run_status && (
                  <div style={{ fontSize: 10, color: sched.last_run_status === 'completed' ? 'var(--green)' : 'var(--red)' }}>
                    Last: {sched.last_run_status}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button
          className="btn btn-primary"
          onClick={() => router.push('/task-runs')}
          style={{ padding: '10px 20px' }}
        >
          <Play width={14} height={14} /> Run Task
        </button>
        <button
          className="btn"
          onClick={() => router.push('/tasks')}
          style={{ padding: '10px 20px' }}
        >
          <Plus width={14} height={14} /> Create Task
        </button>
        <button
          className="btn"
          onClick={() => router.push('/history')}
          style={{ padding: '10px 20px' }}
        >
          <History width={14} height={14} /> View History
        </button>
      </div>
    </div>
  );
}
