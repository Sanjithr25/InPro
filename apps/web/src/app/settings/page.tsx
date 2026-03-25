'use client';

import { useEffect, useState } from 'react';
import { Settings2, Key, Eye, EyeOff, Save, CheckCircle2, Circle, Plus, Trash2 } from 'lucide-react';
import { llmApi, type LlmSettingRow } from '@/lib/api';

const PROVIDER_LABELS: Record<string, { label: string; icon: string; defaultModel: string; defaultBase?: string; suggestedModels?: string[] }> = {
  'llama-local': { label: 'Llama Local (System)', icon: '🦙', defaultModel: 'llama3.2', defaultBase: 'http://localhost:11434/v1', suggestedModels: ['llama3.2', 'llama3.1'] },
  ollama:    { label: 'Ollama Cloud',     icon: '🦙', defaultModel: 'llama3.2',                defaultBase: 'http://localhost:11434/v1', suggestedModels: ['llama3.2', 'glm-5:cloud'] },
  anthropic: { label: 'Anthropic',  icon: '�', defaultModel: 'claude-3-5-sonnet-20241022', defaultBase: undefined, suggestedModels: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'] },
  openai:    { label: 'OpenAI',     icon: '🟢', defaultModel: 'gpt-4o',                  defaultBase: undefined, suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'] },
  gemini:    { label: 'Gemini',     icon: '🔵', defaultModel: 'gemini-2.0-flash',        defaultBase: undefined, suggestedModels: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
  groq:      { label: 'Groq',       icon: '⚡', defaultModel: 'llama-3.3-70b-versatile', defaultBase: 'https://api.groq.com/openai/v1', suggestedModels: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'] },
  custom:    { label: 'Custom Endpoint', icon: '🤖', defaultModel: 'model-name', defaultBase: 'http://custom-api:8080/v1' },
};

function ProviderCard({ setting, onSaved, onDeleted }: { setting: LlmSettingRow; onSaved: () => void; onDeleted: () => void }) {
  const meta = PROVIDER_LABELS[setting.provider] ?? { label: setting.provider, icon: '🤖', defaultModel: '' };
  const [apiKey, setApiKey]   = useState('');
  const [model, setModel]     = useState(setting.model_name);
  const [baseUrl, setBaseUrl] = useState(setting.base_url ?? meta.defaultBase ?? '');
  const [show, setShow]       = useState(false);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await llmApi.update(setting.id, {
        ...(apiKey ? { api_key: apiKey } : {}),
        model_name: model,
        base_url: baseUrl || null,
      });
      setSaved(true);
      setApiKey('');
      setTimeout(() => setSaved(false), 2000);
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
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    setDeleting(true);
    try {
      const result = await llmApi.delete(setting.id);
      alert(result.message);
      onDeleted();
    } catch (err: any) {
      alert(err.message || 'Failed to delete provider');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="card" style={{ position: 'relative' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 28 }}>{meta.icon}</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{meta.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{setting.model_name}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`badge ${setting.has_key ? 'badge-green' : 'badge-red'}`}>
            {setting.has_key ? '● Connected' : '○ No key'}
          </span>
          {setting.is_default && <span className="badge badge-purple">Default</span>}
        </div>
      </div>

      {/* API Key */}
      <div className="form-group">
        <label className="form-label"><Key width={11} height={11} style={{ display: 'inline' }} /> API Key</label>
        <div style={{ position: 'relative' }}>
          <input
            className="form-input"
            type={show ? 'text' : 'password'}
            placeholder={setting.has_key ? '••••••••••••••• (saved — enter new to update)' : 'Paste your API key…'}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            style={{ paddingRight: 40 }}
          />
          <button
            className="btn-icon"
            onClick={() => setShow(s => !s)}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none' }}
          >
            {show ? <EyeOff width={14} height={14} /> : <Eye width={14} height={14} />}
          </button>
        </div>
      </div>

      {/* Base URL */}
      <div className="form-group">
        <label className="form-label">Base URL <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional override)</span></label>
        <input
          className="form-input"
          placeholder={meta.defaultBase ?? 'https://api.provider.com/v1'}
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
        />
      </div>

      {/* Model */}
      <div className="form-group" style={{ marginBottom: 20 }}>
        <label className="form-label">Model</label>
        <input
          className="form-input"
          placeholder={meta.defaultModel}
          value={model}
          onChange={e => setModel(e.target.value)}
        />
        {meta.suggestedModels && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {meta.suggestedModels.map(sm => (
              <button
                key={sm}
                className={`badge ${model === sm ? 'badge-primary' : 'badge-outline'}`}
                style={{ cursor: 'pointer', border: '1px solid var(--border)', background: model === sm ? 'var(--accent)' : 'transparent', color: model === sm ? '#fff' : 'var(--text-muted)' }}
                onClick={() => setModel(sm)}
              >
                {sm}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" /> : saved ? <CheckCircle2 width={14} height={14} /> : <Save width={14} height={14} />}
            {saved ? 'Saved!' : saving ? 'Saving…' : 'Save'}
          </button>
          {!setting.is_default && (
            <button className="btn btn-ghost" onClick={setDefault}>
              <CheckCircle2 width={13} height={13} /> Set as Default
            </button>
          )}
        </div>
        <button 
          className={`btn ${confirmDelete ? 'btn-danger' : 'btn-ghost'}`}
          onClick={handleDelete}
          disabled={deleting}
          onBlur={() => setTimeout(() => setConfirmDelete(false), 200)}
          style={{ marginLeft: 'auto' }}
        >
          {deleting ? <span className="spinner" /> : <Trash2 width={13} height={13} />}
          {confirmDelete ? 'Confirm Delete?' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<LlmSettingRow[]>([]);
  const [adding, setAdding]     = useState(false);
  const [newProv, setNewProv]   = useState({ provider: 'anthropic', model_name: '', api_key: '', base_url: '' });

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
    });
    setAdding(false);
    setNewProv({ provider: 'anthropic', model_name: '', api_key: '', base_url: '' });
    load();
  };

  // Multiple entries per provider type are allowed (e.g. two Ollama configs)

  return (
    <div className="panel-right" style={{ overflow: 'auto' }}>
      <div className="page-title"><Settings2 width={20} height={20} style={{ display: 'inline', marginRight: 8 }} />LLM Settings</div>
      <div className="page-subtitle">Configure AI providers, API keys, and model defaults.</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))', gap: 20 }}>
        {settings.map(s => (
          <ProviderCard key={s.id} setting={s} onSaved={load} onDeleted={load} />
        ))}
      </div>

      {/* Add provider */}
      {!adding ? (
        <button className="btn btn-ghost" style={{ marginTop: 20 }} onClick={() => setAdding(true)}>
          <Plus width={14} height={14} /> Add Provider
        </button>
      ) : (
        <div className="card" style={{ marginTop: 20, maxWidth: 480 }}>
          <div className="card-title">Add New Provider</div>
          <div className="form-group">
            <label className="form-label">Provider Type</label>
            <select className="form-select" value={newProv.provider} onChange={e => setNewProv(p => ({ ...p, provider: e.target.value, base_url: PROVIDER_LABELS[e.target.value]?.defaultBase ?? '' }))}>
              {Object.entries(PROVIDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Model Name</label>
            <input className="form-input" placeholder={PROVIDER_LABELS[newProv.provider]?.defaultModel} value={newProv.model_name} onChange={e => setNewProv(p => ({ ...p, model_name: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Base URL <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional — overrides provider default)</span></label>
            <input className="form-input" placeholder={PROVIDER_LABELS[newProv.provider]?.defaultBase ?? 'https://api.provider.com/v1'} value={newProv.base_url} onChange={e => setNewProv(p => ({ ...p, base_url: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">API Key</label>
            <input className="form-input" type="password" placeholder="Paste your API key…" value={newProv.api_key} onChange={e => setNewProv(p => ({ ...p, api_key: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={addProvider}><Save width={13} height={13} /> Add</button>
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
