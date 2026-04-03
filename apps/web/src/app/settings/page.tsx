'use client';

import { useEffect, useState } from 'react';
import { Settings2, Key, Eye, EyeOff, Save, CheckCircle2, Plus, Trash2, Star, Edit2, Search, Activity, AlertCircle, Zap, Filter, X } from 'lucide-react';
import { llmApi, type LlmSettingRow } from '@/lib/api';

const PROVIDER_LABELS: Record<string, { label: string; icon: string; defaultModel: string; defaultBase?: string; suggestedModels?: string[] }> = {
  'llama-local': { label: 'Llama Local (System)', icon: '🦙', defaultModel: 'llama3.2', defaultBase: 'http://localhost:11434/v1', suggestedModels: ['llama3.2', 'llama3.1'] },
  ollama:    { label: 'Ollama Cloud',     icon: '🦙', defaultModel: 'llama3.2',                defaultBase: 'http://localhost:11434/v1', suggestedModels: ['llama3.2', 'glm-5:cloud'] },
  anthropic: { label: 'Anthropic',  icon: '🟣', defaultModel: 'claude-3-5-sonnet-20241022', defaultBase: undefined, suggestedModels: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'] },
  openai:    { label: 'OpenAI',     icon: '🟢', defaultModel: 'gpt-4o',                  defaultBase: undefined, suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'] },
  gemini:    { label: 'Gemini',     icon: '🔵', defaultModel: 'gemini-2.0-flash',        defaultBase: undefined, suggestedModels: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
  groq:      { label: 'Groq',       icon: '⚡', defaultModel: 'llama-3.3-70b-versatile', defaultBase: 'https://api.groq.com/openai/v1', suggestedModels: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'] },
  custom:    { label: 'Custom Endpoint', icon: '🤖', defaultModel: 'model-name', defaultBase: 'http://custom-api:8080/v1' },
};

// Delete Modal Component
function DeleteModal({ setting, onClose, onConfirm }: { setting: LlmSettingRow; onClose: () => void; onConfirm: () => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const meta = PROVIDER_LABELS[setting.provider] ?? { label: setting.provider, icon: '🤖' };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onConfirm();
      onClose();
    } catch (err: any) {
      alert(err.message || 'Failed to delete provider');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div 
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div 
        className="card" 
        style={{ width: 480, maxWidth: '90vw' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <AlertCircle width={24} height={24} style={{ color: 'var(--red)' }} />
          <div style={{ fontSize: 18, fontWeight: 700 }}>Delete LLM Provider</div>
        </div>
        
        <div style={{ marginBottom: 20, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          You are about to delete <strong>{meta.icon} {meta.label}</strong> ({setting.model_name}).
          <br /><br />
          Type <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{setting.model_name}</strong> to confirm.
        </div>

        <div className="form-group">
          <input
            className="form-input"
            placeholder={`Type ${setting.model_name} to confirm`}
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            autoFocus
          />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button 
            className="btn btn-danger" 
            onClick={handleDelete}
            disabled={confirmText !== setting.model_name || deleting}
          >
            {deleting ? <span className="spinner" /> : <Trash2 width={14} height={14} />}
            {deleting ? 'Deleting...' : 'Delete Provider'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Provider Card Component
function ProviderCard({ setting, onSaved, onDeleted }: { setting: LlmSettingRow; onSaved: () => void; onDeleted: () => void }) {
  const meta = PROVIDER_LABELS[setting.provider] ?? { label: setting.provider, icon: '🤖', defaultModel: '' };
  const [isEditing, setIsEditing] = useState(false);
  const [apiKey, setApiKey]   = useState('');
  const [model, setModel]     = useState(setting.model_name);
  const [baseUrl, setBaseUrl] = useState(setting.base_url ?? meta.defaultBase ?? '');
  const [maxTurns, setMaxTurns] = useState(setting.max_turns ?? 10);
  const [timeoutMs, setTimeoutMs] = useState(setting.timeout_ms ?? 30000);
  const [temperature, setTemperature] = useState(setting.temperature ?? 0.7);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [actualApiKey, setActualApiKey] = useState('');
  const [loadingApiKey, setLoadingApiKey] = useState(false);
  const [copiedApiKey, setCopiedApiKey] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await llmApi.update(setting.id, {
        ...(apiKey ? { api_key: apiKey } : {}),
        model_name: model,
        base_url: baseUrl || null,
        max_turns: maxTurns,
        timeout_ms: timeoutMs,
        temperature: temperature,
      });
      setSaved(true);
      setApiKey('');
      setIsEditing(false);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async () => {
    await llmApi.update(setting.id, { is_default: true });
    onSaved();
  };

  const handleDelete = async () => {
    const result = await llmApi.delete(setting.id);
    alert(result.message);
    onDeleted();
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setModel(setting.model_name);
    setBaseUrl(setting.base_url ?? meta.defaultBase ?? '');
    setMaxTurns(setting.max_turns ?? 10);
    setTimeoutMs(setting.timeout_ms ?? 30000);
    setTemperature(setting.temperature ?? 0.7);
    setApiKey('');
  };

  const viewApiKey = async () => {
    if (!setting.has_key) return;
    setShowApiKeyModal(true);
    setLoadingApiKey(true);
    try {
      // Fetch the actual API key from the backend
      const response = await fetch(`http://localhost:3001/api/llm-settings/${setting.id}/api-key`);
      const data = await response.json();
      setActualApiKey(data.api_key || '');
    } catch (err) {
      setActualApiKey('Error loading API key');
    } finally {
      setLoadingApiKey(false);
    }
  };

  const copyApiKey = () => {
    navigator.clipboard.writeText(actualApiKey);
    setCopiedApiKey(true);
    window.setTimeout(() => setCopiedApiKey(false), 2000);
  };

  return (
    <>
      <div 
        style={{ 
          position: 'relative', 
          transition: 'all 0.2s ease',
          borderBottom: '1px solid var(--border)'
        }}
      >
        {/* Table Row */}
        <div 
          style={{ 
            display: 'grid', 
            gridTemplateColumns: '100px 200px 220px 1fr 180px 80px 80px 80px 120px',
            alignItems: 'center',
            gap: 16,
            padding: '14px 20px',
            background: 'var(--bg-surface)'
          }}
        >
          {/* Status Badge */}
          <span className={`badge ${setting.has_key ? 'badge-green' : 'badge-red'}`} style={{ flexShrink: 0, justifySelf: 'start' }}>
            {setting.has_key ? '● Live' : '○ No Key'}
          </span>

          {/* Provider Name */}
          {!isEditing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 20 }}>{meta.icon}</span>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{meta.label}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 20 }}>{meta.icon}</span>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{meta.label}</div>
            </div>
          )}

          {/* Model Name */}
          {!isEditing ? (
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{setting.model_name}</div>
          ) : (
            <input
              className="form-input"
              value={model}
              onChange={e => setModel(e.target.value)}
              style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* Base URL */}
          {!isEditing ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {setting.base_url || meta.defaultBase || 'Default'}
            </div>
          ) : (
            <input
              className="form-input"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={meta.defaultBase ?? 'https://api.provider.com/v1'}
              style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* API Key */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {setting.has_key ? '••••••••••••' : 'Not set'}
            </div>
            {setting.has_key && (
              <button
                className="btn-icon"
                onClick={(e) => { e.stopPropagation(); viewApiKey(); }}
                title="View API key"
                style={{ background: 'none', border: 'none', padding: 2, color: 'var(--text-muted)' }}
              >
                <Eye width={12} height={12} />
              </button>
            )}
          </div>

          {/* Max Turns */}
          {!isEditing ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>{setting.max_turns ?? 10}</div>
          ) : (
            <input
              className="form-input"
              type="number"
              min="1"
              max="100"
              value={maxTurns}
              onChange={e => setMaxTurns(parseInt(e.target.value) || 10)}
              style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', textAlign: 'center' }}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* Timeout */}
          {!isEditing ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>{((setting.timeout_ms ?? 30000) / 1000).toFixed(0)}s</div>
          ) : (
            <input
              className="form-input"
              type="number"
              min="1"
              max="300"
              value={timeoutMs / 1000}
              onChange={e => setTimeoutMs((parseInt(e.target.value) || 30) * 1000)}
              style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', textAlign: 'center' }}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* Temperature */}
          {!isEditing ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>{(setting.temperature ?? 0.7).toFixed(2)}</div>
          ) : (
            <input
              className="form-input"
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={temperature}
              onChange={e => setTemperature(parseFloat(e.target.value) || 0.7)}
              style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', textAlign: 'center' }}
              onClick={(e) => e.stopPropagation()}
            />
          )}

          {/* Action Icons */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {!isEditing ? (
              <>
                <button 
                  className="btn-icon" 
                  onClick={(e) => { e.stopPropagation(); setDefault(); }}
                  title="Set as default"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: setting.is_default ? 'var(--accent)' : 'var(--text-muted)' }}
                >
                  <Star width={14} height={14} fill={setting.is_default ? 'currentColor' : 'none'} />
                </button>
                <button 
                  className="btn-icon" 
                  onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
                  title="Edit configuration"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                >
                  <Edit2 width={14} height={14} />
                </button>
                <button 
                  className="btn-icon" 
                  onClick={(e) => { e.stopPropagation(); setShowDeleteModal(true); }}
                  title="Delete provider"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--red)' }}
                >
                  <Trash2 width={14} height={14} />
                </button>
              </>
            ) : (
              <>
                <button 
                  className="btn-icon" 
                  onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                  title="Cancel"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                  disabled={saving}
                >
                  <X width={14} height={14} />
                </button>
                <button 
                  className="btn-icon" 
                  onClick={(e) => { e.stopPropagation(); save(); }}
                  title="Save changes"
                  style={{ background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff' }}
                  disabled={saving}
                >
                  {saving ? <span className="spinner" style={{ width: 14, height: 14 }} /> : saved ? <CheckCircle2 width={14} height={14} /> : <Save width={14} height={14} />}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* API Key View Modal */}
      {showApiKeyModal && (
        <div 
          style={{
            position: 'fixed', inset: 0, zIndex: 500,
            background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setShowApiKeyModal(false)}
        >
          <div 
            className="card" 
            style={{ width: 520, maxWidth: '90vw' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>API Key</div>
              <button className="btn-icon" onClick={() => setShowApiKeyModal(false)}>
                <X width={16} height={16} />
              </button>
            </div>
            
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                {meta.icon} {meta.label} - {setting.model_name}
              </div>
              {loadingApiKey ? (
                <div style={{ padding: '20px', textAlign: 'center' }}>
                  <span className="spinner" />
                </div>
              ) : (
                <div style={{ 
                  background: 'var(--bg-elevated)', 
                  border: '1px solid var(--border)', 
                  borderRadius: 8, 
                  padding: '12px 14px',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  wordBreak: 'break-all',
                  color: 'var(--text-primary)'
                }}>
                  {actualApiKey}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowApiKeyModal(false)}>
                Close
              </button>
              <button className="btn btn-primary" onClick={copyApiKey} disabled={loadingApiKey}>
                {copiedApiKey ? <CheckCircle2 width={14} height={14} /> : <Key width={14} height={14} />}
                {copiedApiKey ? 'Copied!' : 'Copy to Clipboard'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <DeleteModal 
          setting={setting} 
          onClose={() => setShowDeleteModal(false)} 
          onConfirm={handleDelete} 
        />
      )}
    </>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<LlmSettingRow[]>([]);
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [adding, setAdding]     = useState(false);
  const [newProv, setNewProv]   = useState({ 
    provider: 'anthropic', 
    model_name: '', 
    api_key: '', 
    base_url: '',
    max_turns: 10,
    timeout_ms: 30000,
    temperature: 0.7
  });

  const load = async () => {
    const s = await llmApi.list();
    setSettings(s);
  };

  useEffect(() => { load(); }, []);

  const addProvider = async () => {
    const meta = PROVIDER_LABELS[newProv.provider];
    await llmApi.create({
      provider: newProv.provider,
      api_key: newProv.api_key,
      base_url: newProv.base_url || meta?.defaultBase || undefined,
      model_name: newProv.model_name || meta?.defaultModel || '',
      max_turns: newProv.max_turns,
      timeout_ms: newProv.timeout_ms,
      temperature: newProv.temperature,
    });
    setAdding(false);
    setNewProv({ 
      provider: 'anthropic', 
      model_name: '', 
      api_key: '', 
      base_url: '',
      max_turns: 10,
      timeout_ms: 30000,
      temperature: 0.7
    });
    load();
  };

  // Filter settings
  const filtered = settings.filter(s => {
    const matchesSearch = s.model_name.toLowerCase().includes(search.toLowerCase()) ||
                          PROVIDER_LABELS[s.provider]?.label.toLowerCase().includes(search.toLowerCase());
    const matchesProvider = providerFilter === 'all' || s.provider === providerFilter;
    return matchesSearch && matchesProvider;
  });

  // Calculate stats
  const liveApis = settings.filter(s => s.has_key).length;
  const totalModels = settings.length;
  const defaultModel = settings.find(s => s.is_default);
  const errors = settings.filter(s => !s.has_key).length;

  // Get unique providers for filter
  const uniqueProviders = Array.from(new Set(settings.map(s => s.provider)));

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '32px 36px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">LLM Settings</div>
          <div className="page-subtitle">Configure AI providers, API keys, and model defaults.</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Search width={14} height={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              className="search-input"
              placeholder="Search providers or models…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 36, paddingRight: search ? 36 : 12, width: 280 }}
            />
            {search && (
              <button
                className="btn-icon"
                onClick={() => setSearch('')}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 4 }}
                title="Clear search"
              >
                <X width={14} height={14} />
              </button>
            )}
          </div>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus width={14} height={14} /> Add New
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {[
          { label: 'Live APIs',      value: liveApis,     color: 'var(--green)',        icon: <Activity width={16} height={16} /> },
          { label: 'Total Models',   value: totalModels,  color: 'var(--text-primary)', icon: <Zap width={16} height={16} /> },
          { label: 'Default Model',  value: defaultModel ? defaultModel.model_name : 'None', color: 'var(--purple)', icon: <Star width={16} height={16} />, isText: true },
          { label: 'Errors',         value: errors,       color: errors > 0 ? 'var(--red)' : 'var(--text-primary)', icon: <AlertCircle width={16} height={16} /> },
        ].map(s => (
          <div key={s.label} className="card" style={{
            padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 0
          }}>
            <div style={{ color: s.color, opacity: 0.85 }}>{s.icon}</div>
            <div>
              <div style={{ fontSize: s.isText ? 13 : 22, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Provider Filter */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 24, flexWrap: 'wrap' }}>
        <Filter width={13} height={13} style={{ color: 'var(--text-muted)' }} />
        <button
          className={`type-pill ${providerFilter === 'all' ? 'select' : ''}`}
          style={{ fontSize: 11, height: 'auto', padding: '4px 12px' }}
          onClick={() => setProviderFilter('all')}
        >
          All Providers
        </button>
        {uniqueProviders.map(provider => (
          <button
            key={provider}
            className={`type-pill ${providerFilter === provider ? 'select' : ''}`}
            style={{ fontSize: 11, height: 'auto', padding: '4px 12px' }}
            onClick={() => setProviderFilter(provider)}
          >
            {PROVIDER_LABELS[provider]?.icon} {PROVIDER_LABELS[provider]?.label || provider}
          </button>
        ))}
      </div>

      {/* Provider Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Table Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '100px 200px 220px 1fr 180px 80px 80px 80px 120px',
          padding: '12px 20px',
          background: 'var(--bg-subtle)',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          gap: 16,
        }}>
          <span>Status</span>
          <span>Provider</span>
          <span>Model</span>
          <span>Base URL</span>
          <span>API Key</span>
          <span style={{ textAlign: 'center' }}>Max Turns</span>
          <span style={{ textAlign: 'center' }}>Timeout</span>
          <span style={{ textAlign: 'center' }}>Temp</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {/* Table Rows */}
        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: '60px 20px' }}>
            <Settings2 width={40} height={40} />
            <p>No providers found.</p>
          </div>
        ) : (
          filtered.map(s => (
            <ProviderCard key={s.id} setting={s} onSaved={load} onDeleted={load} />
          ))
        )}
      </div>

      {/* Add Provider Modal */}
      {adding && (
        <div 
          style={{
            position: 'fixed', inset: 0, zIndex: 500,
            background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setAdding(false)}
        >
          <div 
            className="card" 
            style={{ width: 520, maxWidth: '90vw' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div className="card-title">Add New Provider</div>
              <button className="btn-icon" onClick={() => setAdding(false)}>
                <X width={16} height={16} />
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Provider Type</label>
              <select 
                className="form-select" 
                value={newProv.provider} 
                onChange={e => setNewProv(p => ({ ...p, provider: e.target.value, base_url: PROVIDER_LABELS[e.target.value]?.defaultBase ?? '' }))}
              >
                {Object.entries(PROVIDER_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v.icon} {v.label}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Model Name</label>
              <input 
                className="form-input" 
                placeholder={PROVIDER_LABELS[newProv.provider]?.defaultModel} 
                value={newProv.model_name} 
                onChange={e => setNewProv(p => ({ ...p, model_name: e.target.value }))} 
              />
            </div>

            <div className="form-group">
              <label className="form-label">Base URL <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
              <input 
                className="form-input" 
                placeholder={PROVIDER_LABELS[newProv.provider]?.defaultBase ?? 'https://api.provider.com/v1'} 
                value={newProv.base_url} 
                onChange={e => setNewProv(p => ({ ...p, base_url: e.target.value }))} 
              />
            </div>

            <div className="form-group">
              <label className="form-label">API Key</label>
              <input 
                className="form-input" 
                type="password" 
                placeholder="Paste your API key…" 
                value={newProv.api_key} 
                onChange={e => setNewProv(p => ({ ...p, api_key: e.target.value }))} 
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Max Turns</label>
                <input 
                  className="form-input" 
                  type="number" 
                  min="1"
                  max="100"
                  value={newProv.max_turns}
                  onChange={e => setNewProv(p => ({ ...p, max_turns: parseInt(e.target.value) || 10 }))} 
                />
              </div>

              <div className="form-group">
                <label className="form-label">Timeout (ms)</label>
                <input 
                  className="form-input" 
                  type="number" 
                  min="1000"
                  step="1000"
                  value={newProv.timeout_ms}
                  onChange={e => setNewProv(p => ({ ...p, timeout_ms: parseInt(e.target.value) || 30000 }))} 
                />
              </div>

              <div className="form-group">
                <label className="form-label">Temperature</label>
                <input 
                  className="form-input" 
                  type="number" 
                  min="0"
                  max="2"
                  step="0.1"
                  value={newProv.temperature}
                  onChange={e => setNewProv(p => ({ ...p, temperature: parseFloat(e.target.value) || 0.7 }))} 
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={addProvider}>
                <Save width={13} height={13} /> Add Provider
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
