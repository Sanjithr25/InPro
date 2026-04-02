'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Bot, Plus, Play, Save, Trash2, ChevronRight, ChevronDown, Zap, Clock, Hash, Upload, X, Edit2, AlertTriangle, Copy, Check } from 'lucide-react';
import { agentsApi, toolsApi, llmApi, type AgentRow, type ToolRow, type LlmSettingRow } from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ─── Utility: Relative Time ──────────────────────────────────────────────────
function getRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

// ─── Initial state ────────────────────────────────────────────────────────────
const blank = (): Partial<AgentRow> & { tool_ids: string[] } => ({
  name: '', skill: '', agent_group: '', llm_provider_id: '', tool_ids: [],
});

// ─── Markdown Renderer ───────────────────────────────────────────────────────
function MarkdownRenderer({ content }: { content: string }) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', lineHeight: 1.7, color: 'var(--text-primary)', fontSize: 14 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p style={{ margin: '0 0 12px', lineHeight: 1.7, color: 'var(--text-primary)' }}>{children}</p>
          ),
          h1: ({ children }) => (
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: '20px 0 10px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: '18px 0 8px', color: 'var(--text-primary)' }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: '14px 0 6px', color: 'var(--text-secondary)' }}>{children}</h3>
          ),
          ul: ({ children }) => (
            <ul style={{ margin: '8px 0 12px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: '8px 0 12px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</ol>
          ),
          li: ({ children }) => (
            <li style={{ color: 'var(--text-primary)', lineHeight: 1.6 }}>{children}</li>
          ),
          strong: ({ children }) => (
            <strong style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{children}</strong>
          ),
          em: ({ children }) => (
            <em style={{ fontStyle: 'italic', color: 'var(--text-secondary)' }}>{children}</em>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-hover)', textDecoration: 'underline', textUnderlineOffset: 3 }}>{children}</a>
          ),
          blockquote: ({ children }) => (
            <blockquote style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 14, margin: '12px 0', color: 'var(--text-secondary)', fontStyle: 'italic' }}>{children}</blockquote>
          ),
          hr: () => (
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '12px 0' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{ padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '2px solid var(--border)', textAlign: 'left', fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</th>
          ),
          td: ({ children }) => (
            <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>{children}</td>
          ),
          code: ({ className, children, ...props }: any) => {
            const isBlock = className?.startsWith('language-');
            const lang = className?.replace('language-', '') || '';
            const codeStr = String(children).replace(/\n$/, '');
            if (!isBlock) {
              return (
                <code style={{ background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4, fontSize: '0.87em', fontFamily: 'monospace', color: 'var(--accent-hover)' }}>{children}</code>
              );
            }
            const isCopied = copiedCode === codeStr;
            return (
              <div style={{ position: 'relative', margin: '12px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-elevated)', borderRadius: '8px 8px 0 0', padding: '6px 14px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{lang || 'code'}</span>
                  <button
                    onClick={() => copyCode(codeStr)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: isCopied ? 'var(--green)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 6px', borderRadius: 4, transition: 'color 150ms' }}
                  >
                    {isCopied ? <Check width={12} height={12} /> : <Copy width={12} height={12} />}
                    {isCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '14px 16px', overflowX: 'auto', margin: 0 }}>
                  <code style={{ fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-primary)', whiteSpace: 'pre' }}>{codeStr}</code>
                </pre>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default function AgentsPage() {
  const [agents, setAgents]       = useState<AgentRow[]>([]);
  const [tools, setTools]         = useState<ToolRow[]>([]);
  const [providers, setProviders] = useState<LlmSettingRow[]>([]);
  const [groups, setGroups]       = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    // Restore collapsed state from localStorage
    try {
      const stored = localStorage.getItem('agents-collapsed-groups');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  const [selected, setSelected]   = useState<AgentRow | null>(null);
  const [form, setForm]           = useState(blank());
  const [isNew, setIsNew]         = useState(false);
  const [isEditing, setIsEditing] = useState(false); // edit mode for existing agents
  const [search, setSearch]       = useState('');
  const [saving, setSaving]       = useState(false);
  const [autoCategorizingGroup, setAutoCategorizingGroup] = useState(false);
  const fileInputRef              = useRef<HTMLInputElement>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  // Delete confirmation modal state
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; confirmText: string }>({ open: false, confirmText: '' });

  // Dry run state
  const [dryRunPrompt, setDryRunPrompt] = useState('');
  const [dryRunning, setDryRunning] = useState(false);
  const [latestDryRun, setLatestDryRun] = useState<{
    id: string;
    status: string;
    output: any;
    error: string | null;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
    input_data?: any;
  } | null>(null);
  const [toolExecutions, setToolExecutions] = useState<Array<{
    name: string;
    status: 'running' | 'completed' | 'failed';
    duration?: number;
    error?: string;
    args?: any;
    outputSize?: string;
    output?: any;
  }>>([]);
  const [streamingText, setStreamingText] = useState('');
  const outputRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef<string>('');
  const [renderedOutput, setRenderedOutput] = useState<string>('');

  // Load latest dry run for selected agent
  const loadLatestDryRun = useCallback(async (agentId: string) => {
    try {
      const response = await fetch(`http://localhost:3001/api/agents/${agentId}/dry-runs/latest`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const { data } = await response.json();
      
      // Handle null data (no dry runs yet)
      if (!data) {
        setLatestDryRun(null);
        setToolExecutions([]);
        return null;
      }
      
      // Extract the full execution object from DB
      const resultObj = data.output_data;
      
      // The text is nested as resultObj.output.text or resultObj.output (if it's just the text)
      const actualText = resultObj?.text || resultObj?.output?.text || resultObj?.output || '';
      
      const dryRun = {
        id: data.id,
        status: data.status,
        output: resultObj, // Keep the full object including telemetry
        error: data.error_message,
        started_at: data.started_at,
        ended_at: data.ended_at,
        duration_seconds: data.duration_seconds,
        input_data: data.input_data,
      };
      
      setLatestDryRun(dryRun);
      setRenderedOutput(actualText);

      // Restore tool executions from stored detailed tool executions
      const storedExecutions = resultObj?.toolExecutions || [];
      if (storedExecutions.length > 0) {
        setToolExecutions(storedExecutions.map((te: any) => {
          const success = te.status === 'completed';
          const outputSize = te.output && success ? 
            (typeof te.output === 'string' ? 
              `${(te.output.length / 1024).toFixed(1)}KB` : 
              `${(JSON.stringify(te.output).length / 1024).toFixed(1)}KB`) : 
            undefined;

          return {
            name: te.name,
            status: te.status,
            args: te.arguments,
            output: te.output,
            duration: te.duration,
            outputSize
          };
        }));
      } else {
        setToolExecutions([]);
      }
      
      // If running, start polling
      if (data.status === 'running') {
        setDryRunning(true);
      }
      
      return dryRun;
    } catch (err: any) {
      // Silently handle errors - no dry runs yet or network issue
      setLatestDryRun(null);
      setToolExecutions([]);
      return null;
    }
  }, []);

  // Poll for updates when dry run is running
  useEffect(() => {
    if (!selected || !dryRunning) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:3001/api/agents/${selected.id}/dry-runs/latest`);
        if (!response.ok) return;
        
        const { data } = await response.json();
        
        // Handle null data
        if (!data) return;
        
        // Extract the full execution object
        const resultObj = data.output_data;
        const actualText = resultObj?.text || resultObj?.output?.text || resultObj?.output || '';
        
        setLatestDryRun({
          id: data.id,
          status: data.status,
          output: resultObj,
          error: data.error_message,
          started_at: data.started_at,
          ended_at: data.ended_at,
          duration_seconds: data.duration_seconds,
          input_data: data.input_data,
        });
        setRenderedOutput(actualText);

        // Restore tool executions if present (when completed)
        const storedExecutions = resultObj?.toolExecutions || [];
        if (storedExecutions.length > 0) {
          setToolExecutions(storedExecutions.map((te: any) => {
            const success = te.status === 'completed';
            const outputSize = te.output && success ? 
              (typeof te.output === 'string' ? 
                `${(te.output.length / 1024).toFixed(1)}KB` : 
                `${(JSON.stringify(te.output).length / 1024).toFixed(1)}KB`) : 
              undefined;

            return {
              name: te.name,
              status: te.status,
              args: te.arguments,
              output: te.output,
              duration: te.duration,
              outputSize
            };
          }));
        }

        if (data.status !== 'running') {
          setDryRunning(false);
        }
      } catch (err) {
        // Ignore polling errors
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [selected, dryRunning]);

  // Load everything
  const load = useCallback(async () => {
    const [a, t, p, g] = await Promise.all([
      agentsApi.list(), 
      toolsApi.list(), 
      llmApi.list(),
      agentsApi.getGroups()
    ]);
    setAgents(a);
    setTools(t);
    setProviders(p);
    setGroups(g);
  }, []);

  useEffect(() => { load(); }, [load]);

  const defaultProvider = providers.find(p => p.is_default);

  const filtered = agents.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.agent_group ?? '').toLowerCase().includes(search.toLowerCase())
  );

  // Group agents by agent_group for the sidebar
  const grouped = filtered.reduce<Record<string, AgentRow[]>>((acc, a) => {
    const g = a.agent_group?.trim() || 'Ungrouped';
    if (!acc[g]) acc[g] = [];
    acc[g].push(a);
    return acc;
  }, {});

  const select = async (agent: AgentRow) => {
    const full = await agentsApi.get(agent.id);
    setSelected(full);
    setForm({
      name: full.name,
      skill: full.skill,
      agent_group: full.agent_group ?? '',
      llm_provider_id: full.llm_provider_id ?? '',
      tool_ids: (full.tools ?? []).map(t => t.id),
    });
    setIsNew(false);
    setIsEditing(false); // reset edit mode on agent switch
    setUploadedFileName(null);
    
    // Load latest dry run and restore its prompt + output
    const latestRun = await loadLatestDryRun(full.id);
    if (latestRun) {
      setDryRunPrompt((latestRun.input_data as any)?.prompt || '');
      const text = latestRun.output?.text || latestRun.output?.output?.text || (typeof latestRun.output === 'string' ? latestRun.output : '');
      setRenderedOutput(text);
      streamingTextRef.current = text;
    } else {
      setDryRunPrompt('');
      setRenderedOutput('');
      streamingTextRef.current = '';
    }
    setDryRunning(false);
  };

  const newAgent = () => {
    setSelected(null);
    setForm(blank());
    setIsNew(true);
    setIsEditing(true);
    setUploadedFileName(null);
    setDryRunPrompt('');
    setDryRunning(false);
    setLatestDryRun(null);
    setRenderedOutput('');
    streamingTextRef.current = '';
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name ?? '',
        skill: form.skill ?? '',
        agent_group: form.agent_group ?? '',
        llm_provider_id: form.llm_provider_id || undefined,
        tool_ids: form.tool_ids ?? [],
      };
      if (isNew) {
        const { id } = await agentsApi.create(payload);
        await load();
        const created = await agentsApi.get(id);
        setSelected(created);
        setIsNew(false);
        setIsEditing(false);
      } else if (selected) {
        await agentsApi.update(selected.id, payload);
        await load();
        setIsEditing(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    if (!selected) return;
    // Restore original form values
    setForm({
      name: selected.name,
      skill: selected.skill,
      agent_group: selected.agent_group ?? '',
      llm_provider_id: selected.llm_provider_id ?? '',
      tool_ids: (selected.tools ?? []).map(t => t.id),
    });
    setUploadedFileName(null);
    setIsEditing(false);
  };

  const autoChooseGroup = async () => {
    if (!form.name?.trim()) {
      alert('Please enter an agent name first');
      return;
    }
    
    setAutoCategorizingGroup(true);
    try {
      const { group } = await agentsApi.autoCategorize(form.name, form.skill ?? '');
      setForm(f => ({ ...f, agent_group: group }));
    } catch (err: any) {
      alert(`Auto-categorization failed: ${err.message}`);
    } finally {
      setAutoCategorizingGroup(false);
    }
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      // Persist to localStorage
      try { localStorage.setItem('agents-collapsed-groups', JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const del = async () => {
    if (!selected) return;
    setDeleteModal({ open: true, confirmText: '' });
  };

  const confirmDelete = async () => {
    if (!selected) return;
    await agentsApi.delete(selected.id);
    setDeleteModal({ open: false, confirmText: '' });
    setSelected(null);
    setForm(blank());
    setIsEditing(false);
    await load();
  };

  const run = async () => {
    if (!selected || !dryRunPrompt.trim()) return;
    
    const executionStartTime = Date.now();
    setDryRunning(true);
    setToolExecutions([]);
    streamingTextRef.current = '';
    setRenderedOutput('');
    setStreamingText('');
    
    setLatestDryRun({
      id: 'streaming',
      status: 'running',
      output: { text: '' },
      error: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      duration_seconds: null,
      input_data: { prompt: dryRunPrompt },
    });
    
    try {
      const response = await fetch(`http://localhost:3001/api/agents/${selected.id}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: dryRunPrompt }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to start streaming');
      }
      
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let updateCounter = 0;
      
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          if (line.startsWith('event:')) {
            currentEvent = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.substring(5).trim());
              
              if (currentEvent === 'text' && data.delta) {
                streamingTextRef.current += data.delta;
                // Throttle state updates to every 5 chunks for performance
                updateCounter++;
                if (updateCounter % 5 === 0) {
                  setStreamingText(streamingTextRef.current);
                  if (outputRef.current) {
                    outputRef.current.scrollTop = outputRef.current.scrollHeight;
                  }
                }
              } else if (currentEvent === 'tool_start') {
                // Add tool to execution list
                setToolExecutions(prev => [...prev, {
                  name: data.name,
                  status: 'running',
                  args: data.args,
                }]);
              } else if (currentEvent === 'tool_result') {
                // Update tool status
                const success = !data.result?.error;
                const outputSize = data.result && success ? 
                  (typeof data.result === 'string' ? 
                    `${(data.result.length / 1024).toFixed(1)}KB` : 
                    `${(JSON.stringify(data.result).length / 1024).toFixed(1)}KB`) : 
                  undefined;
                
                setToolExecutions(prev => prev.map((tool, idx) => 
                  idx === prev.length - 1 ? {
                    ...tool,
                    status: success ? 'completed' : 'failed',
                    duration: data.duration,
                    outputSize,
                    output: success ? data.result : undefined,
                    error: success ? undefined : (data.result?.message || data.result?.error || 'Unknown error'),
                  } : tool
                ));
              } else if (currentEvent === 'done') {
                const endTime = Date.now();
                const durationSeconds = Math.round((endTime - executionStartTime) / 1000);
                const finalOutput = data.output || { text: streamingTextRef.current };
                setLatestDryRun(prev => prev ? {
                  ...prev,
                  id: data.runId || prev.id,
                  status: 'completed',
                  output: finalOutput,
                  ended_at: new Date(endTime).toISOString(),
                  duration_seconds: durationSeconds,
                } : null);
                setRenderedOutput(finalOutput.text || streamingTextRef.current);
                setStreamingText('');
                setDryRunning(false);
              } else if (currentEvent === 'error') {
                const endTime = Date.now();
                const durationSeconds = Math.round((endTime - executionStartTime) / 1000);
                setLatestDryRun(prev => prev ? {
                  ...prev,
                  status: 'failed',
                  error: data.message,
                  ended_at: new Date(endTime).toISOString(),
                  duration_seconds: durationSeconds,
                } : null);
                setStreamingText('');
                setDryRunning(false);
              } else if (currentEvent === 'start') {
                setLatestDryRun(prev => prev ? { ...prev, id: data.runId } : null);
              }
            } catch (e) {
              console.error('Failed to parse SSE data:', e, line);
            }
          }
        }
      }
      
      // Final state flush
      const finalText = streamingTextRef.current;
      setRenderedOutput(finalText);
      setStreamingText('');
      setLatestDryRun(prev => prev ? { ...prev, output: { text: finalText } } : null);
      
    } catch (err: any) {
      const endTime = Date.now();
      const durationSeconds = Math.round((endTime - executionStartTime) / 1000);
      
      setDryRunning(false);
      setLatestDryRun(prev => prev ? {
        ...prev,
        status: 'failed',
        error: err.message,
        ended_at: new Date(endTime).toISOString(),
        duration_seconds: durationSeconds,
      } : null);
    }
  };

  const clearDryRun = () => {
    setLatestDryRun(null);
    setDryRunPrompt('');
  };

  const toggleTool = (id: string) =>
    setForm(f => ({
      ...f,
      tool_ids: f.tool_ids?.includes(id)
        ? f.tool_ids.filter(x => x !== id)
        : [...(f.tool_ids ?? []), id],
    }));

  // Upload .md file handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      setForm(f => ({ ...f, skill: text }));
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const clearUploadedFile = () => {
    setUploadedFileName(null);
    setForm(f => ({ ...f, skill: '' }));
  };

  const showForm = isNew || selected !== null;

  // Resolve display label for active provider
  const activeProvider = providers.find(p => p.id === form.llm_provider_id);
  const providerLabel = activeProvider
    ? `${activeProvider.provider} — ${activeProvider.model_name}`
    : defaultProvider
      ? `${defaultProvider.provider} — ${defaultProvider.model_name} (default)`
      : 'System default';

  // Group tools for selection UI dynamically from DB tool_group
  const groupsRaw = tools.reduce<Record<string, ToolRow[]>>((acc, t) => {
    const g = t.tool_group || 'General';
    if (!acc[g]) acc[g] = [];
    acc[g].push(t);
    return acc;
  }, {});

  const groupedTools = Object.keys(groupsRaw)
    .sort((a, b) => {
      if (a === 'Web Search') return -1;
      if (b === 'Web Search') return 1;
      if (a === 'File System') return -1;
      if (b === 'File System') return 1;
      return a.localeCompare(b);
    })
    .map(title => ({
      title,
      items: groupsRaw[title]
    }));

  return (
    <>
    <div className="two-panel">
      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <aside className="panel-left">
        <div className="panel-header">
          <h2>Agents</h2>
          <button className="btn-icon" onClick={newAgent} title="New agent">
            <Plus width={15} height={15} />
          </button>
        </div>

        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search agents or groups…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="list-scroll">
          {filtered.length === 0 && (
            <div className="empty-state">
              <Bot width={32} height={32} />
              <p>No agents yet. <br />Click + to create one.</p>
            </div>
          )}
          {Object.entries(grouped).map(([group, groupAgents]) => {
            const isCollapsed = collapsedGroups.has(group);
            return (
              <div key={group}>
                {/* Group header — only shown when there are multiple groups or a named group */}
                {(Object.keys(grouped).length > 1 || group !== 'Ungrouped') && (
                  <div 
                    onClick={() => toggleGroup(group)}
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
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-surface)';
                      e.currentTarget.style.borderColor = 'var(--accent)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--bg-elevated)';
                      e.currentTarget.style.borderColor = 'var(--border)';
                    }}
                  >
                    {isCollapsed ? (
                      <ChevronRight width={12} height={12} style={{ color: 'var(--text-muted)' }} />
                    ) : (
                      <ChevronDown width={12} height={12} style={{ color: 'var(--text-muted)' }} />
                    )}
                    <span style={{ flex: 1 }}>{group}</span>
                    <span style={{ 
                      fontSize: 9,
                      fontWeight: 600,
                      background: 'var(--accent-dim)',
                      color: 'var(--accent-hover)',
                      padding: '2px 7px',
                      borderRadius: 100,
                      minWidth: 20,
                      textAlign: 'center',
                    }}>
                      {groupAgents.length}
                    </span>
                  </div>
                )}
                {!isCollapsed && groupAgents.map(agent => (
                  <div
                    key={agent.id}
                    className={`list-item${selected?.id === agent.id ? ' selected' : ''}`}
                    onClick={() => select(agent)}
                  >
                    <div className="list-item-name">{agent.name}</div>
                    <div className="list-item-meta">
                      {agent.llm_provider ?? defaultProvider?.provider ?? 'llama-local'} · {agent.provider_model ?? defaultProvider?.model_name ?? 'llama3.2'}
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
        {!showForm ? (
          <div className="empty-state" style={{ height: '100%' }}>
            <Bot width={48} height={48} />
            <p>Select an agent to edit, or click <strong>+</strong> to create one.</p>
            <button className="btn btn-primary" onClick={newAgent}>
              <Plus width={14} height={14} /> New Agent
            </button>
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div className="page-title">{isNew ? 'New Agent' : selected?.name}</div>
                <div className="page-subtitle">
                  {isNew ? 'Configure and save your agent' : (
                    <>
                      ID: {selected?.id}
                      {selected?.updated_at && (
                        <> · Last updated: {getRelativeTime(selected.updated_at)}</>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!isNew && !isEditing && (
                  <>
                    <button className="btn btn-danger" onClick={del}>
                      <Trash2 width={14} height={14} /> Delete
                    </button>
                    <button className="btn btn-ghost" onClick={() => setIsEditing(true)}>
                      <Edit2 width={14} height={14} /> Edit
                    </button>
                  </>
                )}
                {(isNew || isEditing) && (
                  <>
                    {!isNew && (
                      <button className="btn btn-ghost" onClick={cancelEdit}>
                        <X width={14} height={14} /> Cancel
                      </button>
                    )}
                    <button className="btn btn-primary" onClick={save} disabled={saving}>
                      {saving ? <span className="spinner" /> : <Save width={14} height={14} />}
                      {saving ? 'Saving…' : 'Save Agent'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* ── Identity card ───────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Bot width={16} height={16} /> Identity</div>

              <div className="form-group">
                <label className="form-label">Agent Name</label>
                <input
                  id="agent-name"
                  className="form-input"
                  placeholder="e.g. Research Analyst"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  disabled={!isNew && !isEditing}
                />
              </div>

              <div className="form-group">
                <label className="form-label">
                  Group 
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                    (optional — groups agents in the sidebar)
                  </span>
                </label>
                
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                  <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                    <select
                      id="agent-group-select"
                      className="form-select"
                      value={groups.includes(form.agent_group || '') ? form.agent_group : ''}
                      onChange={e => setForm(f => ({ ...f, agent_group: e.target.value }))}
                      style={{ flex: 1 }}
                      disabled={!isNew && !isEditing}
                    >
                      <option value="">Select existing or type new…</option>
                      {groups.map(g => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                    
                    <input
                      id="agent-group-custom"
                      className="form-input"
                      placeholder="Or type new group…"
                      value={!groups.includes(form.agent_group || '') ? (form.agent_group || '') : ''}
                      onChange={e => setForm(f => ({ ...f, agent_group: e.target.value }))}
                      style={{ flex: 1 }}
                      disabled={!isNew && !isEditing}
                    />
                  </div>
                  
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={autoChooseGroup}
                    disabled={(!isNew && !isEditing) || autoCategorizingGroup || !form.name?.trim()}
                    title="Use AI to automatically categorize this agent"
                    style={{ 
                      minWidth: '120px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6
                    }}
                  >
                    {autoCategorizingGroup ? (
                      <>
                        <span className="spinner" style={{ width: 12, height: 12 }} />
                        <span>Analyzing…</span>
                      </>
                    ) : (
                      <>
                        <Zap width={13} height={13} />
                        <span>Auto Choose</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">LLM Provider</label>
                <select
                  id="agent-llm-provider"
                  className="form-select"
                  value={form.llm_provider_id}
                  onChange={e => setForm(f => ({ ...f, llm_provider_id: e.target.value }))}
                  disabled={!isNew && !isEditing}
                >
                  <option value="">
                    {defaultProvider
                      ? `Default — ${defaultProvider.provider} / ${defaultProvider.model_name}`
                      : 'Use system default'}
                  </option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.provider} — {p.model_name}{p.is_default ? ' ✓ default' : ''}
                    </option>
                  ))}
                </select>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                  Active: <strong style={{ color: 'var(--text-secondary)' }}>{providerLabel}</strong>
                </div>
              </div>
            </div>


            {/* ── Skill card ──────────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><ChevronRight width={16} height={16} /> Skill / System Prompt</div>

              {/* Upload button — shows filename after upload */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                {uploadedFileName ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 12px', fontSize: 12 }}>
                    <Upload width={12} height={12} style={{ color: 'var(--accent-hover)' }} />
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{uploadedFileName}</span>
                    {(isNew || isEditing) && (
                      <button
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', display: 'flex', padding: 2, marginLeft: 4 }}
                        onClick={clearUploadedFile}
                        title="Clear uploaded file"
                      >
                        <X width={12} height={12} />
                      </button>
                    )}
                  </div>
                ) : (isNew || isEditing) ? (
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, padding: '5px 12px' }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload width={13} height={13} /> Upload .md file
                  </button>
                ) : null}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Skill description</label>
                <textarea
                  id="agent-skill"
                  className="form-textarea"
                  rows={10}
                  placeholder={"You are a helpful AI assistant that specializes in…\n\nDescribe the agent's role, capabilities, tone, and any constraints."}
                  value={form.skill}
                  onChange={e => setForm(f => ({ ...f, skill: e.target.value }))}
                  disabled={!isNew && !isEditing}
                />
              </div>
            </div>

            {/* ── Tools card ──────────────────────────────────────────────── */}
            <div className="card">
              <div className="card-title"><Zap width={16} height={16} /> Available Tools</div>
              {tools.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tools registered yet. <a href="/tools" style={{ color: 'var(--accent-hover)' }}>Add tools →</a></p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {groupedTools.map(g => g.items.length > 0 && (
                    <div key={g.title}>
                      <div style={{
                        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.05em', color: 'var(--text-muted)',
                        marginBottom: 8
                      }}>
                        {g.title}
                      </div>
                      <div className="tool-chips">
                        {g.items.map(t => (
                          <div
                            key={t.id}
                            className={`tool-chip${form.tool_ids?.includes(t.id) ? ' selected' : ''}${(!isNew && !isEditing) ? ' disabled' : ''}`}
                            onClick={() => (isNew || isEditing) && toggleTool(t.id)}
                            title={`${t.description}\n\nRisk Level: ${t.risk_level || 'low'}`}
                            style={{ 
                              cursor: (!isNew && !isEditing) ? 'default' : 'pointer', 
                              opacity: (!isNew && !isEditing) ? 0.6 : 1,
                              pointerEvents: (!isNew && !isEditing) ? 'none' : 'auto'
                            }}
                          >
                            {t.name}
                            <span className={`risk-badge risk-${t.risk_level || 'low'}`}>
                              {t.risk_level || 'low'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Dry Run — only when agent is saved ──────────────────────── */}
            {!isNew && selected && (
              <div className="card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div className="card-title" style={{ margin: 0 }}><Play width={16} height={16} /> Dry Run</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {latestDryRun && (
                      <button
                        className="btn btn-ghost"
                        onClick={clearDryRun}
                        title="Clear dry run results"
                        style={{ fontSize: 12, padding: '6px 12px' }}
                      >
                        <X width={13} height={13} /> Clear
                      </button>
                    )}
                    <button
                      className="btn btn-primary"
                      onClick={run}
                      disabled={dryRunning || !dryRunPrompt.trim()}
                      style={{ fontSize: 12, padding: '6px 12px' }}
                    >
                      {dryRunning ? <span className="spinner" /> : <Play width={13} height={13} />}
                      {dryRunning ? 'Executing…' : 'Execute'}
                    </button>
                  </div>
                </div>
                
                <div className="form-group">
                  <label className="form-label">Sample Prompt</label>
                  <textarea
                    id="agent-dry-run-prompt"
                    className="form-textarea"
                    rows={3}
                    placeholder="Type a test prompt for this agent…"
                    value={dryRunPrompt}
                    onChange={e => setDryRunPrompt(e.target.value)}
                    disabled={dryRunning}
                  />
                </div>

                {/* Response Output */}
                {(latestDryRun || dryRunning) && (
                  <div style={{ marginTop: 20 }}>
                    {/* Header row */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Response
                      </div>
                      {latestDryRun && !dryRunning && (
                        <div className="output-meta" style={{ margin: 0 }}>
                          {latestDryRun.output?.tokenUsage && (
                            <>
                              <span><Hash width={11} height={11} /> {latestDryRun.output.tokenUsage.inputTokens} in</span>
                              <span><Hash width={11} height={11} /> {latestDryRun.output.tokenUsage.outputTokens} out</span>
                            </>
                          )}
                          {latestDryRun.output?.toolsUsed?.length > 0 && (
                            <span><Zap width={11} height={11} /> {latestDryRun.output.toolsUsed.join(', ')}</span>
                          )}
                          {latestDryRun.output?.providerInfo && (
                            <span>🤖 {latestDryRun.output.providerInfo.model}</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Rendered output panel */}
                    <div
                      ref={outputRef}
                      style={{
                        background: 'var(--bg-base)',
                        border: `1px solid ${latestDryRun?.error ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
                        borderRadius: 12,
                        padding: '18px 20px',
                        maxHeight: 500,
                        overflowY: 'auto',
                        minHeight: 80,
                      }}
                    >
                      {/* Streaming — real-time text preview */}
                      {dryRunning && (
                        <div style={{ fontFamily: 'Inter, sans-serif', lineHeight: 1.7, color: 'var(--text-primary)', fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {streamingText || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Waiting for response…</span>}
                          <span style={{ opacity: 0.5, animation: 'pulse 1s infinite', marginLeft: 2 }}>▍</span>
                        </div>
                      )}

                      {/* Completed — structured markdown render */}
                      {!dryRunning && renderedOutput && (
                        <MarkdownRenderer content={renderedOutput} />
                      )}

                      {/* Completed but no content */}
                      {!dryRunning && !renderedOutput && latestDryRun && (
                        <div style={{ color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>No response content.</div>
                      )}
                    </div>

                    {/* Status bar */}
                    {!dryRunning && latestDryRun && (latestDryRun.status === 'completed' || latestDryRun.status === 'failed') && (
                      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Clock width={12} height={12} />
                        <span suppressHydrationWarning>
                          Last run: {new Date(latestDryRun.ended_at || latestDryRun.started_at).toLocaleString()}
                          {' · '}
                          Status: <strong style={{ color: latestDryRun.status === 'completed' ? 'var(--green)' : 'var(--red)' }}>{latestDryRun.status}</strong>
                          {latestDryRun.duration_seconds !== null && <> · {latestDryRun.duration_seconds}s</>}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Tool Execution Card - show when there are tool executions */}
                {toolExecutions.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Tool Execution
                    </div>
                    <div
                      className="output-panel"
                      style={{
                        maxHeight: 300,
                        overflowY: 'auto',
                        fontFamily: 'monospace',
                        fontSize: 12,
                        lineHeight: 1.6,
                      }}
                    >
                      {toolExecutions.map((tool, idx) => (
                        <div 
                          key={idx}
                          style={{ 
                            padding: '8px 0',
                            borderBottom: idx < toolExecutions.length - 1 ? '1px solid var(--border-subtle)' : 'none'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <span style={{ 
                              color: tool.status === 'running' ? 'var(--accent)' : 
                                     tool.status === 'completed' ? 'var(--green)' : 
                                     'var(--red)',
                              fontWeight: 600,
                              minWidth: 70
                            }}>
                              {tool.status === 'running' && '⟳ Running'}
                              {tool.status === 'completed' && '✓ Done'}
                              {tool.status === 'failed' && '✗ Failed'}
                            </span>
                            <span style={{ flex: 1, color: 'var(--text-primary)', fontWeight: 500 }}>
                              {tool.name}
                            </span>
                            {tool.duration !== undefined && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                {tool.duration}ms
                              </span>
                            )}
                            {tool.outputSize && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                {tool.outputSize}
                              </span>
                            )}
                          </div>

                          {tool.output && (
                            <div style={{ 
                              marginLeft: 78, 
                              fontSize: 11, 
                              color: 'var(--text-secondary)',
                              marginTop: 4,
                              background: 'var(--bg-elevated)',
                              padding: '4px 8px',
                              borderRadius: 4,
                              fontFamily: 'monospace',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all',
                              maxHeight: '150px',
                              overflowY: 'auto'
                            }}>
                              <span style={{ color: 'var(--green)' }}>output:</span> {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
                            </div>
                          )}
                          {tool.error && (
                            <div style={{ 
                              marginLeft: 78, 
                              fontSize: 11, 
                              color: 'var(--red)',
                              marginTop: 4,
                              background: 'rgba(239, 68, 68, 0.1)',
                              padding: '4px 8px',
                              borderRadius: 4,
                              fontFamily: 'monospace',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all',
                              maxHeight: '150px',
                              overflowY: 'auto'
                            }}>
                              <span style={{ fontWeight: 'bold' }}>Error:</span> {tool.error}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Error display */}
                {latestDryRun?.error && (
                  <div style={{ 
                    marginTop: 20, 
                    padding: 12, 
                    background: 'rgba(239,68,68,0.1)', 
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 8,
                    color: 'var(--red)',
                    fontSize: 13
                  }}>
                    <strong>Error:</strong> {latestDryRun.error}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>

    {/* ── Delete Confirmation Modal ─────────────────────────────────────── */}
    {deleteModal.open && selected && (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          background: 'var(--bg-elevated)', border: '1px solid rgba(239,68,68,0.4)',
          borderRadius: 16, padding: 32, maxWidth: 440, width: '90%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ background: 'rgba(239,68,68,0.15)', borderRadius: 10, padding: 10, color: 'var(--red)' }}>
              <AlertTriangle width={22} height={22} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Delete Agent</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>This action cannot be undone</div>
            </div>
          </div>

          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
            To confirm, type <strong style={{ color: 'var(--text-primary)' }}>{selected.name}</strong> below:
          </p>

          <input
            className="form-input"
            placeholder={`Type "${selected.name}" to confirm`}
            value={deleteModal.confirmText}
            onChange={e => setDeleteModal(d => ({ ...d, confirmText: e.target.value }))}
            style={{ marginBottom: 20, borderColor: 'rgba(239,68,68,0.4)' }}
            autoFocus
          />

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              className="btn btn-ghost"
              onClick={() => setDeleteModal({ open: false, confirmText: '' })}
            >
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={confirmDelete}
              disabled={deleteModal.confirmText !== selected.name}
              style={{ opacity: deleteModal.confirmText !== selected.name ? 0.4 : 1 }}
            >
              <Trash2 width={14} height={14} /> Delete Agent
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
