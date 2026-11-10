import { useState } from 'react';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { Select } from './UI';
import { Notice, useMutation, useResource, useSession, request } from './Session';
import type { RelayConfig, Bootstrap } from './types';
import { asObject } from './task-data';
const providers = ['codex', 'claude', 'pi'];
export function SettingsPage({
  onSave,
}: {
  onSave: (revision: string, config: RelayConfig) => Promise<void>;
}) {
  const { bootstrap } = useSession();
  const [snapshot, setSnapshot] = useState(() => (bootstrap ? structuredClone(bootstrap) : null)),
    [config, setConfig] = useState(() => snapshot?.config),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  if (!config || !snapshot) return <p role="status">Loading settings…</p>;
  function update(key: string, value: unknown) {
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  }
  const agents = asObject(config.harnesses) || {},
    routing = asObject(config.routing) || {};
  return (
    <section className="settings-page">
      <div className="page-title">
        <div>
          <h1>Settings</h1>
          <p>Providers, routing, and execution limits.</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMessage('');
            void onSave(snapshot.configRevision, config)
              .then(async () => {
                const next = await request<Bootstrap>('/api/bootstrap');
                setSnapshot(next);
                setConfig(next.config);
                setMessage('Settings saved.');
              })
              .catch((e) => setMessage(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      <section className="surface">
        <h2>Agents</h2>
        <div className="agent-settings">
          {providers.map((id) => {
            const agent = asObject(agents[id]) || {};
            function field(key: string, value: unknown) {
              update('harnesses', { ...agents, [id]: { ...agent, [key]: value } });
            }
            return (
              <article key={id}>
                <div className="section-heading">
                  <h3>{id[0]!.toUpperCase() + id.slice(1)}</h3>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={agent.enabled !== false}
                      onChange={(e) => field('enabled', e.target.checked)}
                    />
                    Enabled
                  </label>
                </div>
                <label className="field">
                  Executable
                  <input
                    value={String(agent.command || id)}
                    onChange={(e) => field('command', e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  Default model
                  <ModelSelect
                    provider={id}
                    value={String(agent.model || '')}
                    onChange={(value) => field('model', value)}
                  />
                </label>
                <label className="field">
                  Effort
                  <Select
                    label={`${id} effort`}
                    value={String(agent.effort || '')}
                    options={['', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
                      value,
                      label: value || 'Provider default',
                    }))}
                    onChange={(value) => field('effort', value)}
                  />
                </label>
              </article>
            );
          })}
        </div>
      </section>
      <section className="surface">
        <h2>Routing</h2>
        <div className="form-grid">
          {['triage', 'investigate', 'plan', 'implement', 'review'].map((stage) => (
            <label className="field" key={stage}>
              {stage}
              <Select
                label={`${stage} provider`}
                value={String(routing[stage] || 'codex')}
                options={providers.map((value) => ({ value, label: value }))}
                onChange={(value) => update('routing', { ...routing, [stage]: value })}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="surface">
        <h2>Workflow limits</h2>
        <div className="form-grid">
          {[
            ['concurrency', 'Concurrent tasks', 1, 8],
            ['timeoutMinutes', 'Agent minutes', 1, 240],
            ['maxRepairRounds', 'Repair rounds', 1, 10],
            ['maxRecoveryAttempts', 'Debugger attempts', 0, 5],
          ].map(([key, label, min, max]) => (
            <label className="field" key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
                value={Number(config[String(key)] || min)}
                onChange={(e) => update(String(key), Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="surface">
        <h2>Relay permissions</h2>
        <p className="muted">Execution and settings proposals always need your approval.</p>
        {Object.entries(asObject(asObject(config.workspaceAgent)?.permissions) || {}).map(
          ([key, value]) => (
            <label className="check-row" key={key}>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) =>
                  update('workspaceAgent', {
                    ...asObject(config.workspaceAgent),
                    permissions: {
                      ...asObject(asObject(config.workspaceAgent)?.permissions),
                      [key]: e.target.checked,
                    },
                  })
                }
              />
              <span>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
            </label>
          ),
        )}
      </section>
    </section>
  );
}
export function ModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { data, refresh, error } =
    useResource<Record<string, { models?: { id: string; name: string }[]; error?: string }>>(
      '/api/models',
    );
  const mutation = useMutation();
  const catalog = data?.[provider];
  const options = [
    { value: '', label: 'Provider default' },
    ...(catalog?.models || []).map((model) => ({ value: model.id, label: model.name })),
  ];
  return (
    <div className="model-control">
      <Select
        label={`${provider} model`}
        value={value}
        options={options}
        onChange={onChange}
        custom
      />
      <button
        type="button"
        className="text-button"
        title={catalog?.error || error || 'Refresh available models'}
        disabled={mutation.busy}
        onClick={() =>
          void mutation
            .run('/api/models/discover', { force: true })
            .then(refresh)
            .catch(() => {})
        }
      >
        Refresh
      </button>
    </div>
  );
}
type Memory = {
  id: string;
  revision: number;
  scope: string;
  targetId: string;
  kind: string;
  status: string;
  title: string;
  content: string;
  evidence: string;
  expiresAt: string | null;
};
export function MemoryPage() {
  const { data, loading, error, refresh } = useResource<Memory[]>('/api/memories');
  const { bootstrap } = useSession(),
    mutation = useMutation();
  const [editing, setEditing] = useState<Partial<Memory> | null>(null),
    [confirm, setConfirm] = useState<Memory | null>(null),
    [query, setQuery] = useState('');
  return (
    <section>
      <div className="page-title">
        <div>
          <h1>Memory</h1>
          <p>Approved knowledge, scoped to where it applies.</p>
        </div>
        <button
          className="primary"
          onClick={() =>
            setEditing({
              scope: 'global',
              targetId: '',
              kind: 'observation',
              status: 'active',
              title: '',
              content: '',
              evidence: '',
            })
          }
        >
          Add memory
        </button>
      </div>
      <div className="page-toolbar">
        <input
          aria-label="Search memories"
          placeholder="Search memory…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {(error || mutation.error) && <Notice>{error || mutation.error}</Notice>}
      {loading && !data && <p>Loading…</p>}
      <div className="record-list">
        {data
          ?.filter((row) =>
            `${row.title} ${row.content}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((row) => (
            <article className="surface" key={row.id}>
              <div className="section-heading">
                <div>
                  <small className="eyebrow">
                    {row.scope} · {row.kind} · {row.status}
                  </small>
                  <h2>{row.title}</h2>
                </div>
                <button onClick={() => setEditing(row)}>Edit</button>
              </div>
              <Markdown text={row.content} />
              {row.evidence && (
                <details>
                  <summary>Evidence</summary>
                  <Markdown text={row.evidence} />
                </details>
              )}
              <div className="record-actions">
                {row.status === 'proposed' && (
                  <button
                    className="primary"
                    disabled={mutation.busy}
                    onClick={() =>
                      void mutation
                        .run(
                          `/api/memories/${row.id}`,
                          { revision: row.revision, status: 'active' },
                          'PATCH',
                        )
                        .then(refresh)
                        .catch(() => {})
                    }
                  >
                    Approve
                  </button>
                )}
                <button className="danger text-button" onClick={() => setConfirm(row)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        {data?.length === 0 && (
          <div className="empty-state">
            <h2>No memories yet</h2>
            <p>Add a preference, or review suggestions from agents.</p>
          </div>
        )}
      </div>
      {editing && (
        <Modal
          title={editing.id ? 'Edit memory' : 'Add memory'}
          onClose={() => {
            if (!mutation.busy) setEditing(null);
          }}
          onSubmit={(e) => {
            e.preventDefault();
            const id = editing.id;
            const body = Object.fromEntries(
              Object.entries(editing).filter(([key]) =>
                [
                  'revision',
                  'scope',
                  'targetId',
                  'kind',
                  'status',
                  'title',
                  'content',
                  'evidence',
                  'expiresAt',
                ].includes(key),
              ),
            );
            void mutation
              .run(`/api/memories${id ? '/' + id : ''}`, body, id ? 'PATCH' : 'POST')
              .then(() => {
                setEditing(null);
                return refresh();
              })
              .catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setEditing(null)} disabled={mutation.busy}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy}>
                Save memory
              </button>
            </>
          }
        >
          {mutation.error && <Notice>{mutation.error}</Notice>}
          <label className="field">
            Title
            <input
              required
              value={editing.title || ''}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              Scope
              <Select
                label="Memory scope"
                value={editing.scope || 'global'}
                options={['global', 'project', 'task'].map((value) => ({ value, label: value }))}
                onChange={(scope) => setEditing({ ...editing, scope, targetId: '' })}
              />
            </label>
            <label className="field">
              Kind
              <Select
                label="Memory kind"
                value={editing.kind || 'observation'}
                options={['observation', 'preference'].map((value) => ({ value, label: value }))}
                onChange={(kind) => setEditing({ ...editing, kind })}
              />
            </label>
          </div>
          {editing.scope === 'project' && (
            <label className="field">
              Repository
              <Select
                label="Memory repository"
                value={editing.targetId || ''}
                options={(bootstrap?.config.repositories || []).map((repo) => ({
                  value: repo.id,
                  label: repo.name,
                }))}
                onChange={(targetId) => setEditing({ ...editing, targetId })}
              />
            </label>
          )}
          {editing.scope === 'task' && (
            <label className="field">
              Task ID
              <input
                required
                value={editing.targetId || ''}
                onChange={(e) => setEditing({ ...editing, targetId: e.target.value })}
              />
            </label>
          )}
          <label className="field">
            Content
            <textarea
              required
              rows={5}
              value={editing.content || ''}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            />
          </label>
          <label className="field">
            Evidence
            <textarea
              rows={2}
              value={editing.evidence || ''}
              onChange={(e) => setEditing({ ...editing, evidence: e.target.value })}
            />
          </label>
        </Modal>
      )}
      {confirm && (
        <Modal
          title="Delete memory?"
          onClose={() => setConfirm(null)}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation
              .run(`/api/memories/${confirm.id}`, { revision: confirm.revision }, 'DELETE')
              .then(() => {
                setConfirm(null);
                return refresh();
              })
              .catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="danger" disabled={mutation.busy}>
                Delete memory
              </button>
            </>
          }
        >
          <p>Delete “{confirm.title}”?</p>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </section>
  );
}
export function InboxPage({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error } = useResource<{
    items: { taskId: string; title: string; status: string; stage: string; summary?: string }[];
  }>('/api/inbox');
  return (
    <section>
      <div className="page-title">
        <div>
          <h1>Inbox</h1>
          <p>Decisions and work that need your attention.</p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="record-list">
        {data?.items.map((item) => (
          <button className="inbox-row" key={item.taskId} onClick={() => onOpen(item.taskId)}>
            <span className="task-status">
              {item.status === 'awaiting_plan'
                ? 'Choose approach'
                : item.status === 'awaiting_final'
                  ? 'Accept changes'
                  : 'Needs attention'}
            </span>
            <span>
              <strong>{item.title}</strong>
              {item.summary && <p>{item.summary}</p>}
            </span>
            <span>Open →</span>
          </button>
        ))}
        {data?.items.length === 0 && (
          <div className="empty-state">
            <h2>All caught up</h2>
            <p>Relay will surface the next decision here.</p>
          </div>
        )}
      </div>
    </section>
  );
}
