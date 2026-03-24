export default function ToolsPage() {
  return (
    <div className="panel-right" style={{ overflow: 'auto' }}>
      <div className="page-title">Tool Management</div>
      <div className="page-subtitle">Phase 2 — coming soon.</div>
      <div className="card">
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Tool CRUD UI will be built in Phase 2. Tools can currently be registered via the API: <code style={{ color: 'var(--accent-hover)' }}>POST /api/tools</code>
        </p>
      </div>
    </div>
  );
}
