import { useEffect, useState } from 'react';
import { Markdown } from './Markdown';
import { TaskPanel } from './TaskPanel';
import { latestPlan } from './task-data';
import { isTask, statusLabel, taskViews, type Task, type TaskView } from './types';
type Details = Task & { description?: string; ticket?: string; demo?: boolean };
function ticketURL(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function TaskPage({
  id,
  tab,
  workflowPreview,
  onAction,
  onTab,
  onBack,
  onDeck,
}: {
  id: string;
  tab: TaskView;
  workflowPreview: boolean;
  onAction: (id: string, action: 'start' | 'resume' | 'pause') => Promise<Task>;
  onTab: (tab: TaskView) => void;
  onBack: () => void;
  onDeck: () => void;
}) {
  const [task, setTask] = useState<Details | null>(null),
    [error, setError] = useState(''),
    [actionError, setActionError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true,
      running = false,
      controller: AbortController | undefined,
      pending = false,
      refreshTimer: number | undefined;
    async function load() {
      if (running) {
        pending = true;
        return;
      }
      running = true;
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
        if (active) {
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
    void load();
    window.addEventListener('relay-data-change', onData);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      window.clearTimeout(refreshTimer);
      window.removeEventListener('relay-data-change', onData);
    };
  }, [id]);
  async function runAction(action: 'start' | 'resume' | 'pause') {
    if (!task || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const updated = await onAction(task.id, action);
      setTask((current) => (current ? { ...current, ...updated } : current));
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Could not update workflow.');
    } finally {
      setBusy(false);
    }
  }
  if (!task)
    return (
      <section className="task-page">
        <button className="back" onClick={onBack}>
          ← All tasks
        </button>
        <p role="status">{error || 'Loading task…'}</p>
      </section>
    );
  const url = task.ticket ? ticketURL(task.ticket) : null;
  const plan = task.status === 'awaiting_plan' ? latestPlan(task) : null;
  return (
    <section className="task-page">
      <button className="back" onClick={onBack}>
        ← All tasks
      </button>
      <div className="task-page-heading">
        <div>
          <h1>{task.title}</h1>
          <div className="task-meta">
            <span className={`task-status status-${task.status}`}>{statusLabel(task.status)}</span>
            <span>{task.repository?.name || 'Unspecified'}</span>
            <span>{task.id.slice(0, 8)}</span>
            {task.demo && <span>Demo</span>}
          </div>
          {task.ticket &&
            (url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {task.ticket} ↗
              </a>
            ) : (
              <span>{task.ticket}</span>
            ))}
        </div>
        <div className="task-page-actions">
          {workflowPreview && !task.demo && task.status === 'draft' && (
            <button className="primary" disabled={busy} onClick={() => void runAction('start')}>
              {busy ? 'Starting…' : 'Start investigation'}
            </button>
          )}
          {workflowPreview && ['queued', 'running'].includes(task.status) && (
            <button disabled={busy} onClick={() => void runAction('pause')}>
              {busy ? 'Stopping…' : 'Pause'}
            </button>
          )}
          {workflowPreview &&
            !task.demo &&
            ['paused', 'interrupted', 'blocked'].includes(task.status) &&
            ['triage', 'investigate', 'plan'].includes(task.stage || '') && (
              <button className="primary" disabled={busy} onClick={() => void runAction('resume')}>
                {busy ? 'Resuming…' : 'Resume'}
              </button>
            )}
          <button onClick={onDeck}>Open task deck</button>
        </div>
      </div>
      <p className="migration-note">
        {workflowPreview
          ? 'Investigation and planning are available for isolated test repositories. This preview cannot coordinate writers with the original Relay. Implementation, verification, and interactive terminals are still being ported.'
          : 'Draft management is available. Workflow execution and interactive terminals are still being ported.'}
      </p>
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
      {plan && (
        <section className="plan-preview" aria-label="Proposed approaches">
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
              <article key={option.id}>
                <h3>
                  {option.title} {option.id === plan.recommendedId && <small>Recommended</small>}
                </h3>
                <Markdown text={option.description} />
                <h4>Tradeoffs</h4>
                <Markdown text={option.tradeoffs} />
              </article>
            ))}
          </div>
          <p className="form-note">
            Approach approval and implementation are not available in this preview yet.
          </p>
        </section>
      )}
      <nav className="detail-nav" aria-label="Task views">
        {taskViews.map((view) => (
          <button
            key={view.id}
            aria-current={tab === view.id ? 'page' : undefined}
            onClick={() => onTab(view.id)}
          >
            {view.label}
          </button>
        ))}
      </nav>
      {tab === 'overview' ? (
        <div className="task-overview">
          <TaskPanel task={task} view="overview" />
          <section className="description-card">
            <h2>Description &amp; requirements</h2>
            {task.description ? (
              <Markdown text={task.description} />
            ) : (
              <p>No description provided.</p>
            )}
          </section>
        </div>
      ) : (
        <div className="task-detail-panel">
          <TaskPanel key={`${id}:${tab}`} task={task} view={tab} />
        </div>
      )}
    </section>
  );
}
