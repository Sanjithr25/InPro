'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Plus, Save, Trash2, Loader2, ChevronDown,
  GitBranch, Sparkles, GripVertical, X, CheckCircle2,
  XCircle, Clock, Zap, ArrowRight, Play, FlaskConical,
} from 'lucide-react';
import {
  tasksApi, agentsApi, llmApi,
  type TaskRow, type WorkflowStep, type AgentRow, type LlmSettingRow
} from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const blankTask = (): Omit<TaskRow, 'id' | 'created_at'> & { entries: WorkflowStep[] } => ({
  name: '', description: '',
  workflow_definition: [],
  entries: [],
  llm_provider_id: null,
});

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function TasksPage() {
  const [tasks, setTasks]       = useState<TaskRow[]>([]);
  const [agents, setAgents]     = useState<AgentRow[]>([]);
  const [llmSettings, setLlmSettings] = useState<LlmSettingRow[]>([]);
  const [selected, setSelected] = useState<TaskRow | null>(null);
  const [form, setForm]         = useState(blankTask());
  const [isNew, setIsNew]       = useState(false);
  const [search, setSearch]     = useState('');
  const [saving, setSaving]     = useState(false);

  // Generate workflow state
  const [generating, setGenerating]  = useState(false);
  const [genAgentIds, setGenAgentIds] = useState<string[]>([]);
  const [savedFeedback, setSavedFeedback] = useState(false);

  // Dry run state
  const [dryRunPrompt, setDryRunPrompt] = useState('');
  const [dryRunning, setDryRunning]     = useState(false);
  const [dryRunResult, setDryRunResult] = useState<{ success: boolean; output: { text: string; steps: number }; error?: string } | null>(null);

  // Drag-drop
  const dragIdx = useRef<number | null>(null);

  const load = useCallback(async () => {
    const [t, a, l] = await Promise.all([tasksApi.list(), agentsApi.list(), llmApi.list()]);
    setTasks(t);
    setAgents(a);
    setLlmSettings(l);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = tasks.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  );
  const defaultLlm = llmSettings.find(l => l.is_default);

  // ── Select ─────────────────────────────────────────────────────────────────
  const selectTask = async (task: TaskRow) => {
    const full = await tasksApi.get(task.id);
    setSelected(full);
    const steps = Array.isArray(full.workflow_definition) ? full.workflow_definition : [];
    setForm({ name: full.name, description: full.description, llm_provider_id: full.llm_provider_id, workflow_definition: steps, entries: steps });
    setGenAgentIds(steps.map(s => s.agentId));
    setIsNew(false);
  };

  // ── New ────────────────────────────────────────────────────────────────────
  const newTask = () => {
    setSelected(null);
    setForm(blankTask());
    setGenAgentIds([]);
    setIsNew(true);
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        workflow_definition: form.entries,
        llm_provider_id: form.llm_provider_id ?? null,
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
        const refreshed = await tasksApi.get(selected.id);
        const steps = Array.isArray(refreshed.workflow_definition) ? refreshed.workflow_definition : [];
        setForm(f => ({ ...f, entries: steps, workflow_definition: steps }));
        setSelected(refreshed);
        setSavedFeedback(true);
        setTimeout(() => setSavedFeedback(false), 2000);
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
      const { steps } = await tasksApi.generateWorkflow(form.description, genAgentIds, form.llm_provider_id);
      setForm(f => ({ ...f, entries: steps }));
    } catch (e: any) {
      alert(`Workflow generation failed: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  // ── Dry Run (inline test, NO history record) ──────────────────────────────
  const runDryRun = async () => {
    if (!selected) return;
    setDryRunning(true);
    setDryRunResult(null);
    // Auto-save first to ensure DB has latest workflow
    try {
      await tasksApi.update(selected.id, {
        name: form.name, description: form.description,
        workflow_definition: form.entries, llm_provider_id: form.llm_provider_id ?? null,
      });
      const result = await tasksApi.dryRun(selected.id, dryRunPrompt);
      setDryRunResult(result);
    } catch (e: any) {
      setDryRunResult({ success: false, output: { text: '', steps: 0 }, error: e.message });
    } finally {
      setDryRunning(false);
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
                  <span style={{ fontSize: 10, color: task.last_run_status === 'completed' ? 'var(--green)' : task.last_run_status === 'failed' ? 'var(--red)' : 'var(--text-muted)', flexShrink: 0 }}>
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
            </div>
          ))}
        </div>
      </aside>

      {/* ── Right panel ─────────────────────────────────────────────────────── */}
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
              <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
                {savedFeedback && (
                  <span style={{ fontSize: 12, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircle2 width={13} height={13} /> Saved!
                  </span>
                )}
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

            {/* ── Identity ──────────────────────────────────────────────────── */}
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

              <div className="form-group">
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

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Task Manager LLM</label>
                <div style={{ position: 'relative' }}>
                  <select
                    className="form-select"
                    value={form.llm_provider_id ?? ''}
                    onChange={e => setForm(f => ({ ...f, llm_provider_id: e.target.value || null }))}
                  >
                    <option value="">
                      Use Default ({defaultLlm ? `${defaultLlm.provider} - ${defaultLlm.model_name}` : 'Not Set'})
                    </option>
                    {llmSettings.map(l => (
                      <option key={l.id} value={l.id}>
                        {l.provider} — {l.model_name} {l.is_default ? '(Default)' : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown width={14} height={14} style={{ position: 'absolute', right: 12, top: 11, pointerEvents: 'none', color: 'var(--text-muted)' }} />
                </div>
              </div>
            </div>

            {/* ── AI Workflow Generator ──────────────────────────────────────── */}
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
                    const sel = genAgentIds.includes(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => toggleGenAgent(agent.id)}
                        style={{
                          fontSize: 12, padding: '4px 12px', borderRadius: 20,
                          border: `1px solid ${sel ? 'var(--accent)' : 'var(--border)'}`,
                          background: sel ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg-elevated)',
                          color: sel ? 'var(--accent-hover)' : 'var(--text-secondary)',
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

            {/* ── Workflow Steps ─────────────────────────────────────────────── */}
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

            {/* ── Dry Run ───────────────────────────────────────────────────── */}
            {!isNew && selected && (
              <div className="card">
                <div className="card-title"><FlaskConical width={16} height={16} /> Dry Run
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>Tests your workflow without saving to Run History</span>
                </div>
                <div className="form-group">
                  <label className="form-label">Initial Prompt <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                  <textarea
                    className="form-textarea"
                    rows={2}
                    placeholder="e.g. Write a blog post about AI in 2025…"
                    value={dryRunPrompt}
                    onChange={e => setDryRunPrompt(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    className="btn btn-ghost"
                    style={{ padding: '8px 18px' }}
                    onClick={runDryRun}
                    disabled={dryRunning || form.entries.length === 0}
                  >
                    {dryRunning
                      ? <><Loader2 width={14} height={14} className="spin" /> Running test…</>
                      : <><FlaskConical width={14} height={14} /> Run Test</>
                    }
                  </button>
                  {dryRunResult && (
                    <button className="btn-icon" style={{ fontSize: 12, color: 'var(--text-muted)' }} onClick={() => setDryRunResult(null)}>✕ Clear</button>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {form.entries.length} step{form.entries.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Dry run result */}
                {dryRunResult && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                      fontSize: 13, fontWeight: 600,
                      color: dryRunResult.success ? 'var(--green)' : 'var(--red)',
                    }}>
                      {dryRunResult.success
                        ? <><CheckCircle2 width={14} height={14} /> Test passed — {dryRunResult.output.steps} step{dryRunResult.output.steps !== 1 ? 's' : ''} executed</>
                        : <><XCircle width={14} height={14} /> Test failed — {dryRunResult.error}</>
                      }
                    </div>
                    {dryRunResult.output.text && (
                      <div style={{
                        background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8,
                        padding: '12px 14px', fontSize: 12, color: 'var(--text-primary)',
                        lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto',
                      }}>
                        {dryRunResult.output.text}
                      </div>
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
