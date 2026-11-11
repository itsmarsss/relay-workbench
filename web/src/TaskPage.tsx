import { WorkflowStatus, TaskResult } from './WorkflowInsights';
import { TaskSidebar } from './TaskSidebar';
import {
  ago,
  nextStep,
  repositoryNames,
  shortDate,
  stageNames,
  ticketLabel,
  ticketURL,
} from './presentation';
import { useMutation } from './Session';
import { AutoControl, ForkLinks } from './WorkflowHistory';
import { useEffect, useState } from 'react';
import { TaskMenu, ContinueWork, PublicationPanel, type FullTask } from './TaskExtras';
import { motion } from 'motion/react';
import { Markdown } from './Markdown';
import { TaskPanel } from './TaskPanel';
import { asObject, asText, currentBlocker, latestPlan } from './task-data';
import { isTask, statusLabel, taskViews, type Task, type TaskView } from './types';
import { Icon } from './Icons';
import { taskLane } from './board';
type Details = Task &
  Record<string, unknown> & {
    description?: string;
    ticket?: string;
    demo?: boolean;
    preset?: string;
  };
// Issue templates leave HTML comments behind; they are instructions to the author, not content.
const visibleDescription = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim();
function Description({ text }: { text: string }) {
  const body = visibleDescription(text),
    long = body.length > 1400 || body.split('\n').length > 24;
  const [open, setOpen] = useState(false);
  return (
    <section className="description-card">
      <h2>Description &amp; requirements</h2>
      {body ? (
        <div className={long && !open ? 'description-body is-clipped' : 'description-body'}>
          <Markdown text={body} />
        </div>
      ) : (
        <p>No description provided.</p>
      )}
      {long && (
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
    resolution: 'retry' | 'replan' | 'pause',
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
    [blockerNote, setBlockerNote] = useState('');
  const planRevision = task ? latestPlan(task)?.attemptId : undefined;
  useEffect(() => {
    setSelectedOption('');
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
  async function resolveDecision(resolution: 'retry' | 'replan' | 'pause') {
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
  const stage = stageNames[task.currentRun?.stage || task.stage || ''] || '';
  const awaitingReview = implementationPreview && task.status === 'awaiting_final';
  const attempts = (Array.isArray(task.attempts) ? task.attempts : []).map(asObject);
  const handoffs = attempts.filter((run) => run?.handoff).length;
  // The list endpoint carries a summary; older and imported tasks only have it on the handoff.
  const summary =
    task.latestSummary ||
    task.error ||
    asText(asObject(attempts.findLast((run) => run?.handoff)?.handoff)?.summary, 600);
  const kicker = (
    <div className="status-kicker">
      <span>{banner.kicker}</span>
      {stage && <span>{stage}</span>}
    </div>
  );
  return (
    <section className="task-page">
      <button className="back" onClick={onBack}>
        <Icon name="back" size={16} />
        All tasks
      </button>
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
            {shortDate(asText(task.createdAt)) && (
              <span>Created {shortDate(asText(task.createdAt))}</span>
            )}
            {task.updatedAt && <span>Updated {ago(task.updatedAt).toLowerCase()}</span>}
            {task.currentRun?.role === 'debug' && task.currentRun.status === 'running' && (
              <span>
                Debugger running · {task.currentRun.harness || 'Agent'} ·{' '}
                {task.currentRun.actualModel || task.currentRun.model || 'CLI default'}
              </span>
            )}
            {task.demo && <span>Demo</span>}
          </div>
        </div>
        <div className="task-page-actions">
          {workflowPreview && task.status === 'draft' && (
            <button className="primary" disabled={busy} onClick={() => void runAction('start')}>
              {busy ? 'Starting…' : task.demo ? 'Run demo' : 'Start investigation'}
            </button>
          )}
          {workflowPreview &&
            ['paused', 'interrupted', 'blocked'].includes(task.status) &&
            !blocker &&
            ['triage', 'investigate', 'plan', 'implement', 'verify', 'review'].includes(
              task.stage || '',
            ) && (
              <button className="primary" disabled={busy} onClick={() => void runAction('resume')}>
                {busy ? 'Resuming…' : 'Resume'}
              </button>
            )}
          {workflowPreview &&
            (['queued', 'running'].includes(task.status) ||
              (task.currentRun?.auxiliary &&
                ['queued', 'running'].includes(task.currentRun.status || ''))) && (
              <button disabled={busy} onClick={() => void runAction('pause')}>
                <Icon name="pause" size={15} />
                {busy ? 'Stopping…' : 'Pause'}
              </button>
            )}
          {asObject(task.migration)?.readOnly !== true && <AutoControl task={task as FullTask} />}
          <button onClick={onDeck}>
            <Icon name="grid" size={15} />
            Open task deck
          </button>
          <TaskMenu task={task} onDeleted={onBack} />
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
                <p>
                  {summary ||
                    (task.status === 'draft'
                      ? 'Relay will investigate, propose an approach and ask before implementing.'
                      : 'No update yet.')}
                </p>
                {task.currentRun?.status === 'running' && (
                  <WorkflowStatus task={task as FullTask} />
                )}
              </div>
              {awaitingReview && (
                <div className="task-page-actions">
                  <button onClick={() => onTab('diff')}>View changes</button>
                  <button
                    className="primary"
                    disabled={busy || !task.taskRevision}
                    onClick={() => void decide('accept')}
                  >
                    {busy ? 'Checking…' : 'Accept result'}
                  </button>
                </div>
              )}
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
              <p>{blocker.summary || 'The debugger needs direction.'}</p>
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
              {(blocker.explanation || blocker.evidence.length > 0) && (
                <details>
                  <summary>
                    Full explanation
                    {blocker.evidence.length > 0 && ` and evidence · ${blocker.evidence.length}`}
                  </summary>
                  {blocker.explanation && <Markdown text={blocker.explanation} />}
                  {blocker.evidence.length > 0 && (
                    <ul>
                      {blocker.evidence.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  )}
                </details>
              )}
              {blocker.options.length > 0 && (
                <div className="plan-options">
                  {blocker.options.map((option) => (
                    <article
                      key={option.id}
                      className={blockerOption === option.id ? 'selectable selected' : 'selectable'}
                      onClick={() => setBlockerOption(option.id)}
                    >
                      <h3>
                        <input
                          type="radio"
                          name="blocker-option"
                          aria-label={`Select ${option.title}`}
                          checked={blockerOption === option.id}
                          onChange={() => setBlockerOption(option.id)}
                        />
                        {option.title}
                      </h3>
                      <Markdown text={option.description} />
                      <h4>Tradeoffs</h4>
                      <Markdown text={option.tradeoffs} />
                    </article>
                  ))}
                </div>
              )}
              {debugRecoveryPreview ? (
                <div className="blocker-actions">
                  <label>
                    Direction (optional)
                    <textarea
                      value={blockerNote}
                      onChange={(event) => setBlockerNote(event.target.value)}
                      maxLength={10000}
                      rows={2}
                    />
                  </label>
                  <div className="task-page-actions">
                    <button
                      className="primary"
                      disabled={busy || !task.taskRevision}
                      onClick={() => void resolveDecision('retry')}
                    >
                      Retry debugger
                    </button>
                    {task.preset !== 'investigate' && (
                      <button
                        disabled={busy || !task.taskRevision}
                        onClick={() => void resolveDecision('replan')}
                      >
                        Revise approach
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
            </section>
          )}
          {plan && (
            <section className="plan-preview" aria-label="Proposed approaches">
              {kicker}
              <h2>Proposed approaches</h2>
              {plan.summary && <p>{plan.summary}</p>}
              {plan.reason && <Markdown text={plan.reason} />}
              {plan.details && (
                <details>
                  <summary>Full proposal</summary>
                  <Markdown text={plan.details} />
                </details>
              )}
              <div className="plan-options">
                {plan.options.map((option) => (
                  <article
                    key={option.id}
                    className={
                      implementationPreview
                        ? selectedOption === option.id
                          ? 'selectable selected'
                          : 'selectable'
                        : ''
                    }
                    onClick={() => {
                      if (implementationPreview) setSelectedOption(option.id);
                    }}
                  >
                    <h3>
                      {implementationPreview && (
                        <input
                          type="radio"
                          name="approach"
                          aria-label={`Select ${option.title}`}
                          checked={selectedOption === option.id}
                          onChange={() => setSelectedOption(option.id)}
                        />
                      )}
                      {option.title}{' '}
                      {option.id === plan.recommendedId && <small>Recommended</small>}
                    </h3>
                    <Markdown text={option.description} />
                    <h4>Tradeoffs</h4>
                    <Markdown text={option.tradeoffs} />
                  </article>
                ))}
              </div>
              {implementationPreview ? (
                <div className="plan-decision">
                  <label>
                    Approval note{' '}
                    <input
                      value={approvalNote}
                      onChange={(event) => setApprovalNote(event.target.value)}
                      maxLength={10000}
                    />
                  </label>
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
                <Description text={task.description || ''} />
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
