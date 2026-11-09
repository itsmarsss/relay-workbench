import { useEffect, useState } from 'react';
import { Markdown } from './Markdown';
import { TaskPanel } from './TaskPanel';
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
  onTab,
  onBack,
  onDeck,
}: {
  id: string;
  tab: TaskView;
  onTab: (tab: TaskView) => void;
  onBack: () => void;
  onDeck: () => void;
}) {
  const [task, setTask] = useState<Details | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true,
      running = false,
      controller: AbortController | undefined;
    async function load() {
      if (running) return;
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
      }
    }
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [id]);
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
        <button onClick={onDeck}>Open task deck</button>
      </div>
      <p className="migration-note">
        Draft management is available. Workflow execution, approval actions, and interactive
        terminals are still being ported.
      </p>
      {error && (
        <p className="error" role="status">
          {error}
        </p>
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
