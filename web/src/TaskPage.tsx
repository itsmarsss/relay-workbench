import { WorkflowStatus, TaskResult } from './WorkflowInsights';
import { TaskSidebar } from './TaskSidebar';
import {
  ago,
  currentStage,
  nextStep,
  repositoryNames,
  shortDate,
  stageNames,
  ticketLabel,
  ticketURL,
  plainSummary,
} from './presentation';
import { Notice, request, useMutation } from './Session';
import { MarkdownEditor } from './MarkdownEditor';
import { SideChat } from './Chat';
import { useImageUpload } from './ImageUpload';
import { AutoControl, ForkLinks } from './WorkflowHistory';
import { useEffect, useState } from 'react';
import { TaskMenu, ContinueWork, PublicationPanel, type FullTask } from './TaskExtras';
import { NotifyOffer } from './Notifications';
import { motion } from 'motion/react';
import { Markdown } from './Markdown';
import { ClampedText, DecisionOptions } from './DecisionOptions';
import { TaskPanel } from './TaskPanel';
import { asObject, asText, currentBlocker, latestPlan } from './task-data';
import { isTask, statusLabel, taskViews, type Task, type TaskView } from './types';
import { Icon } from './Icons';
import type { BlockerResolution } from './api';
import { taskLane } from './board';
type Details = Task &
  Record<string, unknown> & {
    description?: string;
    ticket?: string;
    demo?: boolean;
    preset?: string | null;
  };
// Issue templates leave HTML comments behind; they are instructions to the author, not content.
const visibleDescription = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim();
// The description is edited where it is read. The server accepts the change only while the task
// is idle, and a task that already has a workspace goes back to planning when its text changes.
function Description({ task }: { task: Details }) {
  const text = task.description || '',
    body = visibleDescription(text),
    long = body.length > 1400 || body.split('\n').length > 24;
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<string | null>(null);
  const mutation = useMutation();
  const uploads = useImageUpload((added) => setDraft((value) => (value ?? '') + added));
  const locked = asObject(task.migration)?.readOnly === true,
    active = ['running', 'queued', 'manual'].includes(task.status);
  const entries = [task, ...(Array.isArray(task.repositories) ? task.repositories : [])].map(
    asObject,
  );
  const replans =
    task.status !== 'draft' &&
    entries.some((entry) => !!entry?.workspaceRoot || !!entry?.workspaceDraft);
  function save() {
    if (draft === null || uploads.busy) return;
    if (draft === text) return setDraft(null);
    void mutation
      .run(
        `/api/tasks/${task.id}`,
        { taskRevision: task.taskRevision, description: draft },
        'PATCH',
      )
      .then(() => setDraft(null))
      .catch(() => {});
  }
  return (
    <section className="description-card">
      <div className="section-heading">
        <h2>Description</h2>
        {!locked &&
          draft === null &&
          (active ? (
            <span className="muted">Pause the task to edit</span>
          ) : (
            <button
              className="text-button"
              aria-label="Edit description"
              onClick={() => {
                mutation.clearError();
                setDraft(text);
              }}
            >
              <Icon name="edit" size={14} />
              Edit
            </button>
          ))}
      </div>
      {draft !== null ? (
        <form
          className="description-edit"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            uploads={uploads}
            label="Description and requirements"
          />
          {replans && (
            <p className="form-note">
              Saving a change pauses this task and returns it to planning. You approve a new
              approach before work continues.
            </p>
          )}
          {mutation.error && <Notice>{mutation.error}</Notice>}
          <div className="description-edit-actions">
            <button type="button" disabled={mutation.busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="primary" disabled={mutation.busy || uploads.busy}>
              Save description
            </button>
          </div>
        </form>
      ) : body ? (
        <div className={long && !open ? 'description-body is-clipped' : 'description-body'}>
          <Markdown text={body} />
        </div>
      ) : (
        <p>No description provided.</p>
      )}
      {draft === null && long && (
        <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show full description'}
        </button>
      )}
    </section>
  );
}
function bannerTone(task: Task): { tone: string; kicker: string } {
  const lane = taskLane(task);
  if (['approach', 'final'].includes(lane)) return { tone: 'decision', kicker: 'Needs you' };
  // A pause someone asked for is not a failure.
  if (task.status === 'paused') return { tone: 'neutral', kicker: 'Paused' };
  if (task.status === 'manual') return { tone: 'neutral', kicker: 'Manual control' };
  if (lane === 'attention') return { tone: 'blocked', kicker: 'Needs you' };
  if (['discovery', 'progress', 'review'].includes(lane))
    return task.status === 'queued'
      ? { tone: 'running', kicker: 'Queued' }
      : { tone: 'running', kicker: 'Relay is working' };
  if (['done', 'finished'].includes(lane))
    return { tone: 'done', kicker: statusLabel(task.status) };
  if (lane === 'parked') return { tone: 'neutral', kicker: 'Parked' };
  return { tone: 'neutral', kicker: lane === 'backlog' ? 'Not started' : statusLabel(task.status) };
}
export function TaskPage({
  id,
  tab,
  workflowPreview,
  implementationPreview,
  debugRecoveryPreview,
  onAction,
  onApprove,
  onAccept,
  onResolve,
  onTab,
  onBack,
  onDeck,
}: {
  id: string;
  tab: TaskView;
  workflowPreview: boolean;
  implementationPreview: boolean;
  debugRecoveryPreview: boolean;
  onAction: (id: string, action: 'start' | 'resume' | 'pause') => Promise<Task>;
  onApprove: (
    id: string,
    optionId: string,
    note: string,
    planAttemptId: string,
    taskRevision: string,
  ) => Promise<Task>;
  onAccept: (id: string, taskRevision: string) => Promise<Task>;
  onResolve: (
    id: string,
    taskRevision: string,
    decisionId: string,
    resolution: BlockerResolution,
    optionId: string,
    note: string,
  ) => Promise<Task>;
  onTab: (tab: TaskView) => void;
  onBack: () => void;
  onDeck: () => void;
}) {
  const migrationMutation = useMutation();
  const [task, setTask] = useState<Details | null>(null),
    [error, setError] = useState(''),
    [actionError, setActionError] = useState(''),
    [busy, setBusy] = useState(false),
    [selectedOption, setSelectedOption] = useState(''),
    [approvalNote, setApprovalNote] = useState(''),
    [blockerOption, setBlockerOption] = useState(''),
    [blockerNote, setBlockerNote] = useState(''),
    // Direction typed beside Accept, sent back to the implementer; null while closed.
    [changes, setChanges] = useState<string | null>(null);
  const planRevision = task ? latestPlan(task)?.attemptId : undefined;
  // When the task is waiting on a decision, the keyboard starts on it (Enter or Space decides),
  // unless the person is already somewhere else on the page.
  useEffect(() => {
    if (!task) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      document
        .querySelector<HTMLElement>(
          '.plan-decision .primary, .status-banner .task-page-actions .primary, .blocker-actions .primary',
        )
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [task?.id, task?.status, planRevision, Array.isArray(task?.attempts) && task.attempts.length]);
  // A fresh plan starts with its recommended option (or its only option) chosen, so approving
  // what the planner recommends is one click.
  useEffect(() => {
    const current = task ? latestPlan(task) : null;
    setSelectedOption(
      current?.recommendedId || (current?.options.length === 1 ? current.options[0]!.id : ''),
    );
    setBlockerOption('');
  }, [planRevision]);
  useEffect(() => {
    let active = true,
      running = false,
      controller: AbortController | undefined,
      pending = false,
      generation = 0,
      refreshTimer: number | undefined;
    async function load() {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      const started = generation;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'Task not found.'
              : `Could not load task (${response.status}).`,
          );
        const value: unknown = await response.json();
        if (!isTask(value)) throw new Error('Task data is invalid.');
        if (active && started === generation) {
          const data = value as Task & Record<string, unknown>;
          setTask({
            ...value,
            description: typeof data.description === 'string' ? data.description : undefined,
            ticket: typeof data.ticket === 'string' ? data.ticket : undefined,
            demo: data.demo === true,
          });
          setError('');
        }
      } catch (failure) {
        if (active && !(failure instanceof DOMException && failure.name === 'AbortError'))
          setError(failure instanceof Error ? failure.message : 'Could not load task.');
      } finally {
        running = false;
        if (active && pending) {
          pending = false;
          void load();
        }
      }
    }
    function onData() {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void load();
      }, 200);
    }
    function onUpdate(event: Event) {
      const task = (event as CustomEvent).detail;
      if (isTask(task) && task.id === id) {
        generation++;
        setTask(task as Details);
      }
    }
    void load();
    window.addEventListener('relay-data-change', onData);
    window.addEventListener('relay-task-update', onUpdate);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      window.clearTimeout(refreshTimer);
      window.removeEventListener('relay-data-change', onData);
      window.removeEventListener('relay-task-update', onUpdate);
    };
  }, [id]);
  async function runAction(action: 'start' | 'resume' | 'pause') {
    if (!task || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const updated = await onAction(task.id, action);
      setTask((current) => (current ? { ...current, ...updated } : current));
      window.dispatchEvent(new Event('relay-data-change'));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not update workflow.');
      window.dispatchEvent(new Event('relay-data-change'));
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: 'approve' | 'accept') {
    const currentPlan = task ? latestPlan(task) : null;
    if (
      !task ||
      busy ||
      !task.taskRevision ||
      (action === 'approve' && (!selectedOption || !currentPlan))
    )
      return;
    setBusy(true);
    setActionError('');
    try {
      const updated =
        action === 'approve'
          ? await onApprove(
              task.id,
              selectedOption,
              approvalNote,
              currentPlan!.attemptId,
              task.taskRevision,
            )
          : await onAccept(task.id, task.taskRevision);
      setTask((current) => (current ? { ...current, ...updated } : current));
      window.dispatchEvent(new Event('relay-data-change'));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not record the decision.');
      window.dispatchEvent(new Event('relay-data-change'));
    } finally {
      setBusy(false);
    }
  }
  // Hands a task under manual control back to automation, from the banner.
  async function returnControl() {
    if (!task || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const live = await request<{ terminal?: { session?: string } }>(
        `/api/tasks/${task.id}/terminal`,
      ).catch(() => ({}) as { terminal?: { session?: string } });
      const updated = await migrationMutation.run<Task>(`/api/tasks/${task.id}/return-control`, {
        taskRevision: task.taskRevision,
        session: live.terminal?.session,
      });
      setTask((current) => (current ? { ...current, ...updated } : current));
      window.dispatchEvent(new Event('relay-data-change'));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not return control.');
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!task || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const updated = await migrationMutation.run<Task>(`/api/tasks/${task.id}/publish`, {
        taskRevision: task.taskRevision,
        repositoryId: asObject(task.repository)?.id,
      });
      setTask((current) => (current ? { ...current, ...updated } : current));
      window.dispatchEvent(new Event('relay-data-change'));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not publish.');
    } finally {
      setBusy(false);
    }
  }
  // Sends direction back to an agent: a different approach, or changes before acceptance.
  async function direct(operation: 'replan' | 'request-changes', message: string) {
    if (!task || busy || !task.taskRevision || !message.trim()) return;
    setBusy(true);
    setActionError('');
    try {
      const updated = await migrationMutation.run<Task>(`/api/tasks/${task.id}/${operation}`, {
        taskRevision: task.taskRevision,
        message,
      });
      setTask((current) => (current ? { ...current, ...updated } : current));
      setApprovalNote('');
      setChanges(null);
      window.dispatchEvent(new Event('relay-data-change'));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not send direction.');
    } finally {
      setBusy(false);
    }
  }
  async function resolveDecision(resolution: BlockerResolution) {
    const blocker = task ? currentBlocker(task) : null;
    if (!task || !task.taskRevision || !blocker || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const updated = await onResolve(
        task.id,
        task.taskRevision,
        blocker.id,
        resolution,
        blockerOption,
        blockerNote,
      );
      setTask((current) => (current ? { ...current, ...updated } : current));
      window.dispatchEvent(new Event('relay-data-change'));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not record the decision.');
      window.dispatchEvent(new Event('relay-data-change'));
    } finally {
      setBusy(false);
    }
  }
  if (!task)
    return (
      <section className="task-page">
        <button className="back" onClick={onBack}>
          <Icon name="back" size={16} />
          All tasks
        </button>
        <p role="status">{error || 'Loading task…'}</p>
      </section>
    );
  const url = task.ticket ? ticketURL(task.ticket) : null;
  const plan = task.status === 'awaiting_plan' && tab === 'overview' ? latestPlan(task) : null;
  const blocker = currentBlocker(task);
  const banner = bannerTone(task);
  // A finished task's last stage is history, not where it is now.
  const stage = ['completed', 'finished', 'cancelled', 'draft'].includes(task.status)
    ? ''
    : stageNames[currentStage(task)] || '';
  const awaitingReview = implementationPreview && task.status === 'awaiting_final';
  const attempts = (Array.isArray(task.attempts) ? task.attempts : []).map(asObject);
  const handoffs = attempts.filter((run) => run?.handoff).length;
  // The list endpoint carries a summary; older and imported tasks only have it on the handoff.
  const failed = ['blocked', 'interrupted', 'failed'].includes(task.status);
  const summary =
    (failed && task.error) ||
    task.latestSummary ||
    task.error ||
    asText(asObject(attempts.findLast((run) => run?.handoff)?.handoff)?.summary, 600);
  // The one thing to do next sits in the banner beside the sentence that names it.
  const single = !(Array.isArray(task.repositories) && task.repositories.length > 1);
  const unpublished =
    task.status === 'completed' &&
    !task.demo &&
    single &&
    !asText(asObject(task.publication)?.url) &&
    !asText(asObject(task.pullRequestLink)?.url) &&
    !['running', 'queued'].includes(asText(asObject(task.delivery)?.status));
  const primaryAction =
    task.status === 'manual' ? (
      <button className="primary" disabled={busy} onClick={() => void returnControl()}>
        {busy ? 'Returning…' : 'Return control'}
      </button>
    ) : unpublished && implementationPreview ? (
      <button className="primary" disabled={busy} onClick={() => void publish()}>
        {busy ? 'Publishing…' : 'Publish draft PR'}
      </button>
    ) : workflowPreview && task.status === 'draft' ? (
      <button className="primary" disabled={busy} onClick={() => void runAction('start')}>
        {busy ? 'Starting…' : task.demo ? 'Run demo' : 'Start investigation'}
      </button>
    ) : workflowPreview &&
      ['paused', 'interrupted', 'blocked'].includes(task.status) &&
      !blocker &&
      ['triage', 'investigate', 'plan', 'implement', 'verify', 'review'].includes(
        task.stage || '',
      ) ? (
      <button className="primary" disabled={busy} onClick={() => void runAction('resume')}>
        {/* A blocked stage is run again; a paused or interrupted one carries on. */}
        {task.status === 'blocked'
          ? busy
            ? 'Retrying…'
            : `Retry ${(stageNames[task.stage || ''] || 'stage').toLowerCase()}`
          : busy
            ? 'Resuming…'
            : 'Resume'}
      </button>
    ) : null;
  const kicker = (
    <div className="status-kicker">
      <span>{banner.kicker}</span>
      {stage && <span>{stage}</span>}
    </div>
  );
  return (
    <section className="task-page">
      <div className="task-page-heading">
        <div className="task-page-title">
          <h1>{task.title}</h1>
          <div className="task-meta">
            <span className={`task-status status-${task.status}`}>{statusLabel(task.status)}</span>
            <span>{repositoryNames(task)}</span>
            {task.ticket &&
              (url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" title={task.ticket}>
                  {ticketLabel(url)} ↗
                </a>
              ) : (
                <span>{task.ticket}</span>
              ))}
            <span className="task-id">{task.id.slice(0, 8)}</span>
            {task.updatedAt && <span>Updated {ago(task.updatedAt).toLowerCase()}</span>}
            {task.currentRun?.role === 'debug' && task.currentRun.status === 'running' && (
              <span>
                Debugger running · {task.currentRun.harness || 'Agent'} ·{' '}
                {task.currentRun.actualModel || task.currentRun.model || 'Default model'}
              </span>
            )}
            {task.demo && <span>Demo</span>}
          </div>
        </div>
        <div className="task-page-actions">
          {workflowPreview &&
            (['queued', 'running'].includes(task.status) ||
              (task.currentRun?.auxiliary &&
                ['queued', 'running'].includes(task.currentRun.status || ''))) && (
              <button disabled={busy} onClick={() => void runAction('pause')}>
                <Icon name="pause" size={15} />
                {busy ? 'Stopping…' : 'Pause'}
              </button>
            )}
          {asObject(task.migration)?.readOnly !== true &&
            !['completed', 'finished', 'cancelled'].includes(task.status) && (
              <AutoControl task={task as FullTask} />
            )}
          {asText(task.workspaceRoot) && !['running', 'queued', 'manual'].includes(task.status) && (
            <button
              title="Open an agent or a shell in this task’s worktree, briefed on the task"
              onClick={() => {
                try {
                  sessionStorage.setItem('relay-open-agent', task.id);
                } catch {}
                onTab('terminals');
              }}
            >
              <Icon name="terminal" size={15} />
              Agent terminal
            </button>
          )}
          <SideChat taskId={task.id} />
          <TaskMenu task={task} onDeleted={onBack} onDeck={onDeck} />
        </div>
      </div>

      <div className="task-layout">
        <div className="task-main">
          {/* The decision panels below state the same thing with the controls attached. */}
          {!blocker && !plan && (
            <section className={`status-banner tone-${banner.tone}`} aria-label="Current status">
              <div className="status-banner-body">
                {kicker}
                <h2>{awaitingReview ? 'Ready for your review' : nextStep(task)}</h2>
                {['queued', 'running'].includes(task.status) && <NotifyOffer />}
                {/* The Result and Latest handoff cards below carry a finished run's summary. */}
                {(!handoffs ||
                  !!task.error ||
                  ['queued', 'running', 'blocked', 'interrupted'].includes(task.status)) && (
                  <p>
                    {/* While an agent works, the summary is the previous run's, so say so. */}
                    {summary && task.currentRun?.status === 'running' && (
                      <span className="status-previous">Previous result: </span>
                    )}
                    {plainSummary(summary) ||
                      (task.status === 'draft'
                        ? 'Relay will investigate, propose an approach and ask before implementing.'
                        : 'No update yet.')}
                  </p>
                )}
              </div>
              {awaitingReview && changes === null && (
                <div className="task-page-actions">
                  <button onClick={() => onTab('diff')}>View changes</button>
                  <button disabled={busy || !task.taskRevision} onClick={() => setChanges('')}>
                    Request changes
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !task.taskRevision}
                    onClick={() => void decide('accept')}
                  >
                    {busy ? 'Checking…' : 'Accept result'}
                  </button>
                </div>
              )}
              {awaitingReview && changes !== null && (
                <form
                  className="request-changes"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void direct('request-changes', changes);
                  }}
                >
                  <textarea
                    aria-label="Changes to make"
                    autoFocus
                    rows={3}
                    maxLength={20000}
                    value={changes}
                    placeholder="What should change before you accept? The agent keeps the approved approach, then checks and review run again."
                    onChange={(event) => setChanges(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void direct('request-changes', changes);
                      }
                      if (event.key === 'Escape') setChanges(null);
                    }}
                  />
                  <div className="task-page-actions">
                    <button type="button" onClick={() => setChanges(null)}>
                      Cancel
                    </button>
                    <button className="primary" disabled={busy || !changes.trim()}>
                      {busy ? 'Sending…' : 'Send changes'}
                    </button>
                  </div>
                </form>
              )}
              {!awaitingReview && primaryAction && (
                <div className="task-page-actions">{primaryAction}</div>
              )}
              {/* The live run spans the banner, under its text and actions. */}
              {task.currentRun?.status === 'running' && <WorkflowStatus task={task as FullTask} />}
            </section>
          )}
          {asObject(task.migration)?.readOnly === true && (
            <section className="surface imported-notice">
              <div>
                <h2>Imported history</h2>
                <p>
                  This snapshot cannot run against another instance’s worktrees. Create a draft to
                  start in a new workspace.
                </p>
              </div>
              <button
                className="primary"
                disabled={migrationMutation.busy}
                onClick={() =>
                  void migrationMutation
                    .run<Task>(`/api/tasks/${task.id}/recreate`, {
                      taskRevision: task.taskRevision,
                    })
                    .then((created) => {
                      location.hash = `task/${created.id}/overview`;
                    })
                    .catch(() => {})
                }
              >
                Create fresh draft
              </button>
              {migrationMutation.error && (
                <p className="error" role="alert">
                  {migrationMutation.error}
                </p>
              )}
            </section>
          )}
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
          {error && (
            <p className="error" role="status">
              {error}
            </p>
          )}
          {blocker && (
            <section className="blocker-panel" aria-label="Blocker decision">
              {kicker}
              <h2>Needs your decision</h2>
              <ClampedText text={blocker.summary || 'The debugger needs direction.'} />
              {blocker.required.length > 0 && (
                <div className="blocker-required">
                  <h3>What needs your input</h3>
                  <ul>
                    {blocker.required.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blocker.options.length > 0 && (
                <DecisionOptions
                  key={blocker.id}
                  name="blocker-option"
                  options={blocker.options}
                  selected={blockerOption}
                  onSelect={setBlockerOption}
                />
              )}
              {debugRecoveryPreview ? (
                <div className="blocker-actions">
                  <label>
                    {task.stage === 'verify'
                      ? 'Direction (to mark a failed check environmental, say why)'
                      : 'Direction (optional)'}
                    <textarea
                      value={blockerNote}
                      onChange={(event) => setBlockerNote(event.target.value)}
                      maxLength={10000}
                      rows={2}
                    />
                    {task.stage === 'verify' && blockerNote.trim().length < 10 && (
                      <small className="form-note">
                        To waive a failed check as environmental, say why here (for example, it
                        fails on main too).
                      </small>
                    )}
                  </label>
                  <div className="task-page-actions">
                    <button
                      className="primary"
                      disabled={busy || !task.taskRevision}
                      onClick={() => void resolveDecision('retry')}
                    >
                      {blockerOption ? 'Continue with this choice' : 'Try again'}
                    </button>
                    {task.preset !== 'investigate' && (
                      <button
                        disabled={busy || !task.taskRevision}
                        onClick={() => void resolveDecision('replan')}
                      >
                        Revise approach
                      </button>
                    )}
                    {task.stage === 'verify' && (
                      <button
                        disabled={busy || !task.taskRevision || blockerNote.trim().length < 10}
                        title={
                          blockerNote.trim().length < 10
                            ? 'Say in the direction box why the failure is environmental, for example that it fails on main too'
                            : 'Waive the failed check and send the work to independent review'
                        }
                        onClick={() => void resolveDecision('environmental')}
                      >
                        Waive as environmental
                      </button>
                    )}
                    <button
                      disabled={busy || !task.taskRevision}
                      onClick={() => void resolveDecision('pause')}
                    >
                      Pause
                    </button>
                  </div>
                </div>
              ) : (
                <p>Debugger actions are not available in this preview yet.</p>
              )}
              {(blocker.explanation || blocker.evidence.length > 0) && (
                <details className="decision-reference">
                  <summary>
                    Full explanation
                    {blocker.evidence.length > 0 && ` and evidence · ${blocker.evidence.length}`}
                  </summary>
                  {blocker.explanation && <Markdown text={blocker.explanation} />}
                  {blocker.evidence.length > 0 && <h4>Evidence</h4>}
                  {blocker.evidence.length > 0 && (
                    <ul>
                      {blocker.evidence.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  )}
                </details>
              )}
            </section>
          )}
          {plan && (
            <section className="plan-preview" aria-label="Proposed approaches">
              {kicker}
              <h2>Proposed approaches</h2>
              {plan.summary && <ClampedText text={plan.summary} />}
              <DecisionOptions
                key={plan.attemptId}
                name="approach"
                options={plan.options}
                selected={selectedOption}
                onSelect={implementationPreview ? setSelectedOption : undefined}
                recommendedId={plan.recommendedId}
                reason={plan.reason}
              />
              {implementationPreview ? (
                <div className="plan-decision">
                  <label>
                    Approval note{' '}
                    <input
                      value={approvalNote}
                      onChange={(event) => setApprovalNote(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          selectedOption &&
                          !busy &&
                          (!approvalNote.trim() || event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault();
                          void decide('approve');
                        }
                      }}
                      placeholder="Optional direction, or what you want instead"
                      maxLength={10000}
                    />
                  </label>
                  <button
                    disabled={busy || !approvalNote.trim() || !task.taskRevision}
                    title={
                      approvalNote.trim()
                        ? 'Plan again with this note as direction'
                        : 'Write what you want instead in the note'
                    }
                    onClick={() => void direct('replan', approvalNote)}
                  >
                    Ask for another approach
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !selectedOption || !task.taskRevision}
                    onClick={() => void decide('approve')}
                  >
                    {busy ? 'Approving…' : 'Approve approach'}
                  </button>
                </div>
              ) : (
                <p className="form-note">
                  Approach approval and implementation are not available in this preview yet.
                </p>
              )}
              {plan.details && (
                <details className="decision-reference">
                  <summary>Full proposal</summary>
                  <Markdown text={plan.details} />
                </details>
              )}
            </section>
          )}
          <nav className="detail-nav" aria-label="Task views">
            {taskViews.map((view) => (
              <button
                key={view.id}
                aria-current={tab === view.id ? 'page' : undefined}
                onClick={() => onTab(view.id)}
              >
                <Icon
                  name={
                    {
                      overview: 'grid',
                      thread: 'clock',
                      terminals: 'terminal',
                      diff: 'code',
                      handoffs: 'git',
                      transcript: 'list',
                    }[view.id]
                  }
                  size={16}
                />
                {view.label}
                {view.id === 'handoffs' && !!handoffs && (
                  <span className="count-chip">{handoffs}</span>
                )}
                {tab === view.id && (
                  <motion.span className="scope-indicator" layoutId={`task-view-${task.id}`} />
                )}
              </button>
            ))}
          </nav>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16 }}
          >
            {tab === 'overview' ? (
              <div className="task-overview">
                <ForkLinks task={task as FullTask} />
                <PublicationPanel task={task as FullTask} />
                <TaskResult task={task as FullTask} onTab={onTab} />
                <Description task={task} />
                {asObject(task.migration)?.readOnly !== true && !task.demo && (
                  <ContinueWork task={task as FullTask} />
                )}
              </div>
            ) : (
              <div className="task-detail-panel">
                <TaskPanel key={`${id}:${tab}`} task={task} view={tab} />
              </div>
            )}
          </motion.div>
        </div>
        <TaskSidebar task={task as FullTask} />
      </div>
    </section>
  );
}
