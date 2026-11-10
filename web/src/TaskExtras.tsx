import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Markdown } from './Markdown';
import { useImageUpload } from './ImageUpload';
import { Modal } from './Modal';
import { Icon, Select } from './UI';
import { ModelSelect, EffortSelect } from './WorkspacePages';
import { AgentSettings, agentOptions } from './AgentSettings';
import { Notice, useMutation, useResource, useSession, request } from './Session';
import { asObject, asText } from './task-data';
import type { Task } from './types';
import { CheckpointControls, type History } from './WorkflowHistory';
export type FullTask = Task & Record<string, unknown>;
export function TaskMenu({ task, onDeleted }: { task: Task; onDeleted?: () => void }) {
  const mutation = useMutation(),
    { bootstrap } = useSession();
  const [confirm, setConfirm] = useState(false),
    [editing, setEditing] = useState<FullTask | null>(null),
    [loadError, setLoadError] = useState('');
  async function edit() {
    try {
      const value = await request<FullTask>(`/api/tasks/${task.id}`);
      setEditing(value);
      setLoadError('');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load task');
    }
  }
  async function remove() {
    try {
      const value = await request<FullTask>(`/api/tasks/${task.id}`);
      await mutation.run(`/api/tasks/${task.id}`, { taskRevision: value.taskRevision }, 'DELETE');
      setConfirm(false);
      onDeleted?.();
    } catch {}
  }
  return (
    <>
      {loadError && <Notice>{loadError}</Notice>}
      <button onClick={() => void edit()} disabled={!bootstrap}>
        Edit task
      </button>
      <button className="text-button danger" onClick={() => setConfirm(true)}>
        Delete
      </button>
      {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} />}{' '}
      {confirm && (
        <Modal
          title="Delete task?"
          onClose={() => setConfirm(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void remove();
          }}
          footer={
            <>
              <button type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button className="danger" disabled={mutation.busy}>
                Delete task
              </button>
            </>
          }
        >
          <p>Delete “{task.title}” and its activity? Workspace files are retained.</p>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </>
  );
}
function TaskEditor({ task, onClose }: { task: FullTask; onClose: () => void }) {
  const [title, setTitle] = useState(task.title),
    [description, setDescription] = useState(asText(task.description, 50000)),
    [ticket, setTicket] = useState(asText(task.ticket, 2000)),
    [preview, setPreview] = useState(false),
    [agents, setAgents] = useState(() => agentOptions(task));
  const {bootstrap} = useSession();
  const mutation = useMutation();
  const uploads = useImageUpload((text) => setDescription((value) => value + text));
  const [parseError, setParseError] = useState('');
  return (
    <Modal
      title="Edit task"
      onClose={() => {
        if (!mutation.busy) onClose();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (uploads.busy) return;
        try {
          const body = {
            taskRevision: task.taskRevision,
            title,
            description,
            ticket,
            ...agents,
          };
          void mutation
            .run(`/api/tasks/${task.id}`, body, 'PATCH')
            .then(onClose)
            .catch(() => {});
        } catch {
          setParseError('Could not save the task settings.');
        }
      }}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={mutation.busy || uploads.busy}>
            Save changes
          </button>
        </>
      }
    >
      {(mutation.error || parseError) && <Notice>{mutation.error || parseError}</Notice>}
      <label className="field">
        Title
        <input required value={title} maxLength={240} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        Issue reference
        <input value={ticket} maxLength={2000} onChange={(e) => setTicket(e.target.value)} />
      </label>
      <div className="section-heading">
        <h3>Description</h3>
        <div className="segmented">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
            Write
          </button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
      </div>
      {preview ? (
        <Markdown text={description} />
      ) : (
        <textarea
          aria-label="Description"
          onPaste={uploads.onPaste}
          onDrop={uploads.onDrop}
          onDragOver={uploads.onDragOver}
          rows={7}
          maxLength={50000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      )}
      {uploads.control}
      <details>
        <summary>Agent and execution overrides</summary>
        {bootstrap && <AgentSettings config={bootstrap.config} value={agents} onChange={setAgents} />}
      </details>
    </Modal>
  );
}
export function ContinueWork({ task }: { task: FullTask }) {
  const { bootstrap } = useSession(),
    mutation = useMutation();
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState(''),
    [provider, setProvider] = useState(asText(asObject(task.routing)?.implement) || 'codex'),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState('');
  const active = ['queued', 'running', 'manual'].includes(task.status);
  const followupBusy =
    Array.isArray(task.deliveryRuns) &&
    task.deliveryRuns.some((item) => {
      const run = asObject(item);
      return run?.stage === 'followup' && ['queued', 'running'].includes(String(run.status));
    });
  const uploads = useImageUpload((text) => setMessage((value) => value + text));
  return (
    <section className="surface continuation">
      <div className="section-heading">
        <div>
          <h2>Continue work</h2>
          <p className="muted">Give the next agent direction.</p>
        </div>
        <button onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Close' : 'Continue'}
          <Icon name="chevron" size={14} />
        </button>
      </div>
      {open && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (uploads.busy) return;
              void mutation
                .run(
                  `/api/tasks/${task.id}/${active ? 'message' : task.status === 'completed' ? 'followup' : 'request-changes'}`,
                  {
                    taskRevision: task.taskRevision,
                    message,
                    ...(active ? {} : { provider, model, effort }),
                  },
                )
                .then(() => setMessage(''))
                .catch(() => {});
            }}
          >
            <textarea
              aria-label="Agent direction"
              onPaste={uploads.onPaste}
              onDrop={uploads.onDrop}
              onDragOver={uploads.onDragOver}
              placeholder={
                active
                  ? 'Direction for the next turn…'
                  : task.status === 'completed'
                    ? 'Ask a question, request an edit, or update the PR…'
                    : 'What should the agent change?'
              }
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              required
              maxLength={20000}
            />
            {!active && (
              <div className="agent-composer-options">
                <div className="segmented">
                  {['codex', 'claude', 'pi'].map((id) => (
                    <button
                      type="button"
                      key={id}
                      aria-pressed={provider === id}
                      disabled={
                        asObject(asObject(bootstrap?.config.harnesses)?.[id])?.enabled === false
                      }
                      onClick={() => {
                        setProvider(id);
                        setModel('');
                        setEffort('');
                      }}
                    >
                      {id}
                    </button>
                  ))}
                </div>
                <ModelSelect provider={provider} value={model} onChange={setModel} />
                <EffortSelect provider={provider} value={effort} onChange={setEffort} />
              </div>
            )}
            {uploads.control}
            {mutation.error && <Notice>{mutation.error}</Notice>}
            <div className="composer-footer">
              <small>
                {active
                  ? 'Delivered at the next agent turn.'
                  : task.status === 'completed'
                    ? 'A working agent uses the retained workspace. Source changes return through checks and review.'
                    : 'Uses the approved approach, then verifies and reviews the changes.'}
              </small>
              <button
                className="primary"
                disabled={mutation.busy || followupBusy || uploads.busy || !message.trim()}
              >
                {followupBusy
                  ? 'Agent working…'
                  : mutation.busy
                    ? 'Sending…'
                    : active
                      ? 'Send direction'
                      : 'Run agent'}
              </button>
            </div>
          </form>
        </motion.div>
      )}
    </section>
  );
}
function entries(task: FullTask): Record<string, unknown>[] {
  return Array.isArray(task.repositories) && task.repositories.length > 1
    ? task.repositories.map(asObject).filter((x): x is Record<string, unknown> => !!x)
    : [task];
}
export function PublicationPanel({ task }: { task: FullTask }) {
  const mutation = useMutation();
  const rows = entries(task);
  if (task.status !== 'completed' && !rows.some((row) => row.publication || row.delivery))
    return null;
  return (
    <section className="surface publication-panel">
      <div className="section-heading">
        <h2>Pull requests</h2>
        <span className="muted">
          {rows.length} {rows.length === 1 ? 'repository' : 'repositories'}
        </span>
      </div>
      {rows.map((row) => {
        const repo = asObject(row.repository),
          publication = asObject(row.publication),
          delivery = asObject(row.delivery),
          monitor = asObject(row.publicationMonitor),
          feedback = Array.isArray(row.feedback) ? row.feedback : [];
        const url = asText(publication?.url);
        const valid = /^https?:\/\//.test(url);
        const busy =
          delivery?.status === 'running' ||
          delivery?.status === 'queued' ||
          monitor?.status === 'running';
        function act(operation: string, extra: Record<string, unknown> = {}) {
          void mutation
            .run(`/api/tasks/${task.id}/${operation}`, {
              taskRevision: task.taskRevision,
              repositoryId: repo?.id,
              ...extra,
            })
            .catch(() => {});
        }
        return (
          <article className="pr-row" key={asText(repo?.id)}>
            <div className="section-heading">
              <div>
                <strong>{asText(repo?.name) || 'Repository'}</strong>
                {valid ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {asText(publication?.title) || `Pull request ${asText(publication?.number)}`} ↗
                  </a>
                ) : (
                  <p className="muted">
                    {asText(delivery?.summary) || 'Ready to publish accepted changes.'}
                  </p>
                )}
              </div>
              <div className="inline">
                {publication && <span className="task-status">{asText(publication.state)}</span>}
                {task.status === 'completed' && !publication && (
                  <button
                    className="primary"
                    disabled={mutation.busy || busy}
                    onClick={() => act('publish')}
                  >
                    {busy ? 'Publishing…' : 'Publish draft PR'}
                  </button>
                )}
                {publication && (
                  <button disabled={mutation.busy || busy} onClick={() => act('monitor')}>
                    {monitor?.status === 'running' ? 'Refreshing…' : 'Refresh'}
                  </button>
                )}
              </div>
            </div>
            {publication && (
              <div className="pr-status">
                <span>
                  Checks <strong>{asText(publication.checks)}</strong>
                </span>
                <span>
                  Review <strong>{asText(publication.review)}</strong>
                </span>
                <span>{publication.draft === true ? 'Draft' : 'Ready for review'}</span>
              </div>
            )}
            {delivery?.status === 'blocked' && <Notice>{asText(delivery.summary)}</Notice>}
            {publication && (
              <details>
                <summary>
                  Feedback &amp; automation {feedback.length > 0 && `(${feedback.length})`}
                </summary>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={monitor?.enabled === true}
                    disabled={mutation.busy || busy}
                    onChange={(e) => act('publication', { enabled: e.target.checked })}
                  />
                  Monitor PR status
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={asObject(row.feedbackAutomation)?.enabled === true}
                    disabled={mutation.busy || busy}
                    onChange={(e) => act('feedback', { enabled: e.target.checked })}
                  />
                  Let agents address actionable feedback
                </label>
                {feedback.map((item, i) => {
                  const f = asObject(item);
                  return (
                    <article className="feedback-item" key={i}>
                      <strong>{asText(f?.summary)}</strong>
                      <Markdown text={asText(f?.details)} />
                    </article>
                  );
                })}
                {feedback.length === 0 && <p className="muted">No actionable feedback observed.</p>}
              </details>
            )}
          </article>
        );
      })}
      {mutation.error && <Notice>{mutation.error}</Notice>}
    </section>
  );
}
export function ExecutionGraph({ task }: { task: FullTask }) {
  const history = useResource<History>(`/api/tasks/${task.id}/history`);
  const attempts = [
    ...(Array.isArray(task.attempts) ? task.attempts : []),
    ...(Array.isArray(task.deliveryRuns) ? task.deliveryRuns : []),
  ]
    .map(asObject)
    .filter((row): row is Record<string, unknown> => !!row && row.stage !== 'monitor');
  const [selected, setSelected] = useState(''),
    [zoom, setZoom] = useState(1),
    canvas = useRef<HTMLDivElement>(null);
  const active = attempts.find((row) => row.id === selected) || attempts.at(-1);
  useEffect(() => {
    const node = canvas.current?.querySelector(
      `[data-run-id="${selected.replace(/[^a-zA-Z0-9-]/g, '')}"]`,
    );
    node?.scrollIntoView({
      behavior: document.documentElement.dataset.lowMotion === 'true' ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [selected]);
  const width = Math.max(640, attempts.length * 210 + 40);
  return (
    <section className="surface execution-section">
      <div className="section-heading">
        <div>
          <h2>Execution</h2>
          <small className="muted">
            {attempts.length} runs · {task.currentRun?.harness || 'No active agent'}
          </small>
        </div>
        <div className="inline">
          <CheckpointControls task={task} history={history.data} />
          <button aria-label="Zoom out" onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}>
            −
          </button>
          <span className="muted">{Math.round(zoom * 100)}%</span>
          <button aria-label="Zoom in" onClick={() => setZoom(Math.min(1.5, zoom + 0.1))}>
            +
          </button>
        </div>
      </div>
      {attempts.length === 0 ? (
        <p className="muted">The execution path appears when a task starts.</p>
      ) : (
        <>
          <div className="execution-canvas" ref={canvas}>
            <div className="execution-world" style={{ width: width * zoom, height: 250 * zoom }}>
              <div
                style={{
                  width,
                  height: 250,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              >
                <svg className="graph-edges" width={width} height={250} aria-hidden="true">
                  <defs>
                    <marker
                      id={`arrow-${task.id}`}
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                    >
                      <path d="M0 0 8 4 0 8Z" fill="currentColor" />
                    </marker>
                  </defs>
                  {attempts.slice(1).map((row, i) => {
                    const a = attempts[i]!,
                      y1 = a.role === 'debug' ? 166 : 62,
                      y2 = row.role === 'debug' ? 166 : 62,
                      x1 = 28 + i * 210 + 174,
                      x2 = 28 + (i + 1) * 210;
                    return (
                      <path
                        key={String(row.id)}
                        d={`M${x1},${y1} C${x1 + 22},${y1} ${x2 - 22},${y2} ${x2},${y2}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        markerEnd={`url(#arrow-${task.id})`}
                      />
                    );
                  })}
                </svg>
                {attempts.map((row, i) => (
                  <button
                    data-run-id={asText(row.id)}
                    key={asText(row.id)}
                    className={`graph-node ${row.id === active?.id ? 'selected' : ''} ${row.status === 'running' ? 'is-running' : ''}`}
                    style={{ left: 28 + i * 210, top: row.role === 'debug' ? 126 : 22, width: 174 }}
                    onClick={() => setSelected(asText(row.id))}
                  >
                    <span className="graph-node-label">
                      {row.role === 'debug' ? 'Debugger' : asText(row.stage)}
                    </span>
                    <strong>{asText(row.harness) || 'Relay'}</strong>
                    <small>
                      {asText(row.status)}
                      {row.startedAt && row.finishedAt
                        ? ` · ${Math.max(0, Math.round((Date.parse(String(row.finishedAt)) - Date.parse(String(row.startedAt))) / 1000))}s`
                        : ''}
                    </small>
                  </button>
                ))}
              </div>
            </div>
          </div>
          {active && (
            <div className="execution-detail">
              <div className="section-heading">
                <h3>
                  {active.role === 'debug' ? 'Debugger' : asText(active.stage)} ·{' '}
                  {asText(active.harness)}
                </h3>
                <small>{asText(active.model) || 'Provider default model'}</small>
              </div>
              <Markdown
                text={asText(
                  asObject(active.handoff)?.summary || active.error || 'Agent is working…',
                )}
              />
              {!!asObject(active.handoff)?.details && (
                <details>
                  <summary>Run details</summary>
                  <Markdown text={asText(asObject(active.handoff)?.details)} />
                </details>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
