'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Plus, Save, Trash2, Play, Loader2, ChevronDown,
  GitBranch, Sparkles, GripVertical, X, CheckCircle2,
  XCircle, Clock, Zap, ArrowRight, RotateCcw,
} from 'lucide-react';
import {
  tasksApi, agentsApi,
  type TaskRow, type WorkflowStep, type AgentRow,
} from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const blankTask = (): Omit<TaskRow, 'id' | 'created_at'> & { entries: WorkflowStep[] } => ({
  name: '', description: '',
  workflow_definition: [],
  entries: [],
});

const statusColor: Record<string, string> = {
  completed: 'var(--green)',
  failed:    'var(--red)',
  running:   'var(--accent-hover)',
  pending:   'var(--yellow)',
};

const statusIcon: Record<string, React.ReactNode> = {
  completed: <CheckCircle2 width={12} height={12} />,
  failed:    <XCircle      width={12} height={12} />,
  running:   <Loader2      width={12} height={12} className="spin" />,
  pending:   <Clock        width={12} height={12} />,
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function TasksPage() {
  const [tasks, setTasks]       = useState<TaskRow[]>([]);
  const [agents, setAgents]     = useState<AgentRow[]>([]);
  const [selected, setSelected] = useState<TaskRow | null>(null);
  const [form, setForm]         = useState(blankTask());
  const [isNew, setIsNew]       = useState(false);
  const [search, setSearch]     = useState('');
  const [saving, setSaving]     = useState(false);

  // Generate workflow state
  const [generating, setGenerating]  = useState(false);
  const [genAgentIds, setGenAgentIds] = useState<string[]>([]);

  // Run state
  const [running, setRunning]      = useState(false);
  const [runPrompt, setRunPrompt]  = useState('');
  const [runResult, setRunResult]  = useState<{ success: boolean; output: { text: string; steps: number }; error?: string; tokenUsage?: { inputTokens: number; outputTokens: number } } | null>(null);

  // Drag-drop
  const dragIdx = useRef<number | null>(null);

  const load = useCallback(async () => {
    const [t, a] = await Promise.all([tasksApi.list(), agentsApi.list()]);
    setTasks(t);
    setAgents(a);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = tasks.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  );

  // ── Select ─────────────────────────────────────────────────────────────────
  const selectTask = async (task: TaskRow) => {
    const full = await tasksApi.get(task.id);
    setSelected(full);
    const steps = Array.isArray(full.workflow_definition) ? full.workflow_definition : [];
    setForm({ name: full.name, description: full.description, workflow_definition: steps, entries: steps });
    setGenAgentIds(steps.map(s => s.agentId));
    setIsNew(false);
    setRunResult(null);
    setRunPrompt('');
  };

  // ── New ────────────────────────────────────────────────────────────────────
  const newTask = () => {
    setSelected(null);
    setForm(blankTask());
    setGenAgentIds([]);
    setIsNew(true);
    setRunResult(null);
    setRunPrompt('');
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        workflow_definition: form.entries,
      };
      if (isNew) {
        const { id } = await tasksApi.create(payload);
        await load();
        const created = await tasksApi.get(id);
        await selectTask(created);
        setIsNew(false);
      } else if (selected) {
        await tasksApi.update(selected.id, payload);
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const del = async () => {
    if (!selected || !confirm(`Delete task "${selected.name}"?`)) return;
    await tasksApi.delete(selected.id);
    setSelected(null);
    setForm(blankTask());
    await load();
  };

  // ── Generate workflow ──────────────────────────────────────────────────────
  const generateWorkflow = async () => {
    if (!form.description.trim() || genAgentIds.length === 0) return;
    setGenerating(true);
    try {
      const { steps } = await tasksApi.generateWorkflow(form.description, genAgentIds);
      setForm(f => ({ ...f, entries: steps }));
    } catch (e: any) {
      alert(`Workflow generation failed: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  // ── Run task ───────────────────────────────────────────────────────────────
  const runTask = async () => {
    if (!selected) return;
    setRunning(true);
    setRunResult(null);
    try {
      const result = await tasksApi.run(selected.id, runPrompt);
      setRunResult(result as any);
      await load(); // refresh last_run_status
    } catch (e: any) {
      setRunResult({ success: false, output: { text: '', steps: 0 }, error: e.message });
    } finally {
      setRunning(false);
    }
  };

  // ── Step management ────────────────────────────────────────────────────────
  const addStep = () => {
    if (agents.length === 0) return;
    const step: WorkflowStep = { agentId: agents[0].id, stepName: 'New Step', description: '' };
    setForm(f => ({ ...f, entries: [...f.entries, step] }));
  };

  const updateStep = (i: number, patch: Partial<WorkflowStep>) =>
    setForm(f => ({ ...f, entries: f.entries.map((s, idx) => idx === i ? { ...s, ...patch } : s) }));

  const removeStep = (i: number) =>
    setForm(f => ({ ...f, entries: f.entries.filter((_, idx) => idx !== i) }));

  // ── Drag-drop reorder ──────────────────────────────────────────────────────
  const onDragStart = (i: number) => { dragIdx.current = i; };
  const onDragOver  = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    const from = dragIdx.current;
    if (from === null || from === i) return;
    setForm(f => {
      const next = [...f.entries];
      const [item] = next.splice(from, 1);
      next.splice(i, 0, item);
      dragIdx.current = i;
      return { ...f, entries: next };
    });
  };
  const onDragEnd = () => { dragIdx.current = null; };

  // ── Agent multi-select for generation ─────────────────────────────────────
  const toggleGenAgent = (id: string) =>
    setGenAgentIds(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]);

  const agentName = (id: string) => agents.find(a => a.id === id)?.name ?? id;

  const showForm = isNew || selected !== null;

  return (
    <div className="two-panel">

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Tasks</h2>
          <button className="btn-icon" onClick={newTask} title="New task">
            <Plus width={15} height={15} />
          </button>
        </div>

        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search tasks…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {tasks.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 14px 8px', display: 'flex', gap: 8 }}>
            <span>{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{tasks.filter(t => t.last_run_status === 'completed').length} completed</span>
          </div>
        )}

        <div className="list-scroll">
          {filtered.length === 0 && (
            <div className="empty-state">
              <GitBranch width={32} height={32} />
              <p>No tasks yet.<br />Click + to create a workflow.</p>
            </div>
          )}

          {filtered.map(task => (
            <div
              key={task.id}
              className={`list-item${selected?.id === task.id ? ' selected' : ''}`}
              onClick={() => selectTask(task)}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span className="list-item-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {task.name}
                </span>
                {task.last_run_status && (
                  <span style={{ fontSize: 10, color: statusColor[task.last_run_status] ?? 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                    {statusIcon[task.last_run_status]}
                    {task.last_run_status}
                  </span>
                )}
              </div>
              <div className="list-item-meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {task.description || 'No description'}
                </span>
                {typeof task.step_count === 'number' && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                    {task.step_count} step{task.step_count !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              {task.last_run_at && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  {timeAgo(task.last_run_at)}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* ── Right panel ───────────────────────────────────────────────────── */}
      <div className="panel-right">

        {!showForm && (
          <div className="empty-state" style={{ height: '100%' }}>
            <GitBranch width={48} height={48} />
            <p>Select a task to configure,<br />or click <strong>+</strong> to build a new workflow.</p>
            <button className="btn btn-primary" onClick={newTask}>
              <Plus width={14} height={14} /> New Task
            </button>
          </div>
        )}

        {showForm && (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div className="page-title">{isNew ? 'New Task' : selected?.name}</div>
                <div className="page-subtitle">
                  {isNew ? 'Define a multi-agent workflow' : `ID: ${selected?.id}`}
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

            {/* ── Identity ─────────────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><GitBranch width={16} height={16} /> Task Identity</div>

              <div className="form-group">
                <label className="form-label">Task Name</label>
                <input
                  id="task-name"
                  className="form-input"
                  placeholder="e.g. Daily Research Report, Code Review Pipeline…"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Description
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — used for LLM workflow generation</span>
                </label>
                <textarea
                  id="task-description"
                  className="form-textarea"
                  rows={3}
                  placeholder="What should this task accomplish? e.g. Research a topic, summarize findings, generate a report…"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                />
              </div>
            </div>

            {/* ── AI Workflow Generator ─────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Sparkles width={16} height={16} /> AI Workflow Generator</div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                Select agents and let the LLM auto-generate the step sequence from your task description.
              </p>

              {/* Agent multi-select */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Select agents to include:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {agents.length === 0 && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No agents found — create agents first.</span>
                  )}
                  {agents.map(agent => {
                    const selected = genAgentIds.includes(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => toggleGenAgent(agent.id)}
                        style={{
                          fontSize: 12, padding: '4px 12px', borderRadius: 20,
                          border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                          background: selected ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg-elevated)',
                          color: selected ? 'var(--accent-hover)' : 'var(--text-secondary)',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >
                        {agent.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={generateWorkflow}
                disabled={generating || !form.description.trim() || genAgentIds.length === 0}
              >
                {generating
                  ? <><Loader2 width={13} height={13} className="spin" /> Generating…</>
                  : <><Sparkles width={13} height={13} /> Generate Workflow Steps</>
                }
              </button>

              {generating && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
                  Asking LLM to plan the workflow — this may take a few seconds…
                </p>
              )}
            </div>

            {/* ── Workflow Steps ────────────────────────────────────────────── */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div className="card-title" style={{ margin: 0 }}>
                  <Zap width={16} height={16} /> Workflow Steps
                  {form.entries.length > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                      {form.entries.length} step{form.entries.length !== 1 ? 's' : ''} — drag to reorder
                    </span>
                  )}
                </div>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={addStep}>
                  <Plus width={12} height={12} /> Add Step
                </button>
              </div>

              {form.entries.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                  <GitBranch width={32} height={32} style={{ margin: '0 auto 10px', opacity: 0.4 }} />
                  <p>No steps yet. Use the AI generator above or add steps manually.</p>
                </div>
              )}

              {/* Step list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {form.entries.map((step, i) => (
                  <div
                    key={i}
                    draggable
                    onDragStart={() => onDragStart(i)}
                    onDragOver={e => onDragOver(e, i)}
                    onDragEnd={onDragEnd}
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      padding: '12px 14px',
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      cursor: 'grab',
                    }}
                  >
                    {/* Step number + drag handle */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 2, flexShrink: 0 }}>
                      <GripVertical width={14} height={14} style={{ color: 'var(--text-muted)', opacity: 0.6 }} />
                      <div style={{
                        width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 10, fontWeight: 700,
                        background: 'var(--accent)', color: '#fff',
                      }}>
                        {i + 1}
                      </div>
                    </div>

                    {/* Step fields */}
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          className="form-input"
                          placeholder="Step name"
                          style={{ fontSize: 13, flex: 1 }}
                          value={step.stepName}
                          onChange={e => updateStep(i, { stepName: e.target.value })}
                        />
                        <select
                          className="form-select"
                          style={{ fontSize: 12, flex: 1 }}
                          value={step.agentId}
                          onChange={e => updateStep(i, { agentId: e.target.value })}
                        >
                          {agents.map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
                      </div>
                      <textarea
                        className="form-textarea"
                        rows={2}
                        placeholder="What should this agent do at this step?"
                        style={{ fontSize: 12 }}
                        value={step.description}
                        onChange={e => updateStep(i, { description: e.target.value })}
                      />
                    </div>

                    {/* Remove */}
                    <button className="btn-icon" style={{ padding: 4, marginTop: 2 }} onClick={() => removeStep(i)}>
                      <X width={13} height={13} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Step flow preview */}
              {form.entries.length > 1 && (
                <div style={{
                  marginTop: 16, padding: '10px 14px',
                  background: 'var(--bg-surface)', borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                }}>
                  {form.entries.map((s, i) => (
                    <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px',
                        borderRadius: 12, background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)', color: 'var(--text-secondary)',
                        maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {agentName(s.agentId)}
                      </span>
                      {i < form.entries.length - 1 && (
                        <ArrowRight width={12} height={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* ── Dry Run ──────────────────────────────────────────────────── */}
            {!isNew && selected && (
              <div className="card">
                <div className="card-title"><Play width={16} height={16} /> Run Task</div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                  Execute all {form.entries.length} step{form.entries.length !== 1 ? 's' : ''} sequentially.
                  Each agent's output feeds into the next step's context.
                </p>

                <div className="form-group">
                  <label className="form-label">Initial Prompt <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                  <textarea
                    className="form-textarea"
                    rows={3}
                    placeholder="e.g. Research the latest AI trends and summarize key developments…"
                    value={runPrompt}
                    onChange={e => setRunPrompt(e.target.value)}
                  />
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    className="btn btn-primary"
                    style={{ padding: '8px 20px' }}
                    onClick={runTask}
                    disabled={running || form.entries.length === 0}
                  >
                    {running
                      ? <><Loader2 width={14} height={14} className="spin" /> Running {form.entries.length} steps…</>
                      : <><Play width={14} height={14} /> Run Task</>
                    }
                  </button>
                  {runResult && (
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setRunResult(null)}>
                      <RotateCcw width={12} height={12} /> Clear
                    </button>
                  )}
                </div>

                {/* Run result */}
                {runResult && (
                  <div style={{ marginTop: 20 }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                      fontSize: 13, fontWeight: 600,
                      color: runResult.success ? 'var(--green)' : 'var(--red)',
                    }}>
                      {runResult.success
                        ? <><CheckCircle2 width={15} height={15} /> Completed {runResult.output.steps} step{runResult.output.steps !== 1 ? 's' : ''}</>
                        : <><XCircle width={15} height={15} /> Failed — {runResult.error}</>
                      }
                      {runResult.tokenUsage && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 'auto' }}>
                          {(runResult.tokenUsage.inputTokens + runResult.tokenUsage.outputTokens).toLocaleString()} tokens
                        </span>
                      )}
                    </div>

                    {runResult.output.text && (
                      <RunOutputAccordion text={runResult.output.text} />
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Run output accordion — splits steps by separator ─────────────────────────
function RunOutputAccordion({ text }: { text: string }) {
  const sections = text.split(/\n---\n/).filter(Boolean);
  const [openIdx, setOpenIdx] = useState<number>(sections.length - 1);

  if (sections.length === 0) return null;

  // Single section — just show it
  if (sections.length === 1) {
    return (
      <div style={{
        background: 'var(--bg-surface)', borderRadius: 'var(--radius)',
        border: '1px solid var(--border)', padding: '14px 16px',
        fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.7,
        whiteSpace: 'pre-wrap', maxHeight: 400, overflowY: 'auto',
      }}>
        {text.trim()}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {sections.map((section, i) => {
        const headline = section.split('\n')[0].replace(/^#+\s*/, '').trim();
        const body     = section.split('\n').slice(1).join('\n').trim();
        const isOpen   = openIdx === i;

        return (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setOpenIdx(isOpen ? -1 : i)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'var(--bg-elevated)', border: 'none', padding: '10px 14px',
                cursor: 'pointer', color: 'var(--text-primary)',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)',
                  color: '#fff', fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {i + 1}
                </span>
                {headline || `Step ${i + 1}`}
              </span>
              <ChevronDown width={14} height={14} style={{ transform: isOpen ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform 0.18s', flexShrink: 0 }} />
            </button>

            {isOpen && body && (
              <div style={{
                padding: '12px 14px', fontSize: 13, color: 'var(--text-primary)',
                lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 340, overflowY: 'auto',
                background: 'var(--bg-surface)',
              }}>
                {body}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
