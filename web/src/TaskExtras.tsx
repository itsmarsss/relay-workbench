import { useState } from 'react';
import { motion } from 'motion/react';
import { Markdown } from './Markdown';
import { useImageUpload } from './ImageUpload';
import { Modal } from './Modal';
import { Icon, Select } from './UI';
import { ModelSelect, EffortSelect } from './WorkspacePages';
import { AgentSettings, agentOptions } from './AgentSettings';
import { Notice, useMutation, useSession, request } from './Session';
import { asObject, asText } from './task-data';
import type { Task } from './types';
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
      <button
        onClick={() => void edit()}
        disabled={!bootstrap || asObject((task as FullTask).migration)?.readOnly === true}
      >
        Edit task
      </button>
      <WorkspaceCleanup task={task as FullTask} />
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
  const { bootstrap } = useSession();
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
        {bootstrap && (
          <AgentSettings config={bootstrap.config} value={agents} onChange={setAgents} />
        )}
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
  if (asObject(task.workspaceCleanup)?.status === 'removed')
    return (
      <section className="surface">
        <h2>Workspace removed</h2>
        <p>Continue from a saved checkpoint to reopen this work in a new workspace.</p>
      </section>
    );
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
          asObject(task.migration)?.readOnly === true ||
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
export { ExecutionGraph } from './ExecutionGraph';

function WorkspaceCleanup({ task }: { task: FullTask }) {
  const mutation = useMutation();
  const [open, setOpen] = useState(false),
    [includeIgnored, setIncludeIgnored] = useState(false);
  if (
    task.status !== 'completed' ||
    !task.workspaceRoot ||
    asObject(task.migration)?.readOnly === true
  )
    return null;
  return (
    <>
      <button onClick={() => setOpen(true)}>Clean up workspace</button>
      {open && (
        <Modal
          title="Remove published worktrees?"
          onClose={() => {
            if (!mutation.busy) setOpen(false);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void mutation
              .run(`/api/tasks/${task.id}/cleanup`, {
                taskRevision: task.taskRevision,
                includeIgnored,
              })
              .then(() => setOpen(false))
              .catch(() => {});
          }}
          footer={
            <>
              <button type="button" disabled={mutation.busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="danger" disabled={mutation.busy}>
                Remove clean worktrees
              </button>
            </>
          }
        >
          <p>
            Removes this instance’s clean worktrees after every repository is published. Branches,
            pull requests and checkpoints stay available. Continue from a checkpoint to work again.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeIgnored}
              onChange={(event) => setIncludeIgnored(event.target.checked)}
            />
            Also remove ignored files, including generated builds and dependencies
          </label>
          <p className="muted">
            Local changes block cleanup. Attached and externally managed checkouts are excluded.
          </p>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </>
  );
}
