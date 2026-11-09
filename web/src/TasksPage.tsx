import { useState } from 'react';
import { statusLabel, type Task } from './types';
const columns = [
  ['draft', 'Backlog'],
  ['discovery', 'Investigation & design'],
  ['awaiting_plan', 'Approach approval'],
  ['progress', 'In progress'],
  ['review', 'In review'],
  ['awaiting_final', 'Final approval'],
  ['attention', 'Needs attention'],
  ['completed', 'Done'],
  ['cancelled', 'Cancelled'],
] as const;
export function taskLane(task: Task): string {
  if (['draft', 'awaiting_plan', 'awaiting_final', 'completed', 'cancelled'].includes(task.status))
    return task.status;
  if (['blocked', 'paused', 'manual', 'interrupted'].includes(task.status)) return 'attention';
  if (task.stage === 'review') return 'review';
  if (task.stage === 'implement' || task.stage === 'verify') return 'progress';
  return 'discovery';
}
export function TasksPage({
  tasks,
  onOpen,
  onCreate,
}: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState(''),
    [layout, setLayout] = useState<'board' | 'list'>('board');
  const visible = tasks.filter((task) =>
    `${task.title} ${task.repository?.name || ''} ${task.id}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const card = (task: Task) => (
    <button key={task.id} className="task-card" onClick={() => onOpen(task.id)}>
      <span className={`task-status status-${task.status}`}>{statusLabel(task.status)}</span>
      <strong>{task.title}</strong>
      <small>{task.repository?.name || 'Unspecified'}</small>
      {(task.latestSummary || task.error) && <p>{task.error || task.latestSummary}</p>}
      <span className="task-reference">
        {task.id.slice(0, 8)} · {task.currentRun?.harness || task.stage || 'Draft'}
      </span>
    </button>
  );
  return (
    <section className="tasks-page">
      <div className="page-title">
        <div>
          <h1>All tasks</h1>
          <p>
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
          </p>
        </div>
        <button className="primary" onClick={onCreate}>
          New task
        </button>
      </div>
      <div className="page-toolbar">
        <input
          type="search"
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div role="group" aria-label="Task layout">
          <button aria-pressed={layout === 'board'} onClick={() => setLayout('board')}>
            Board
          </button>
          <button aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>
            List
          </button>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="empty-state">
          <h2>{tasks.length ? 'No matching tasks' : 'No tasks yet'}</h2>
          <p>Create a draft to add requirements and repositories.</p>
        </div>
      ) : layout === 'list' ? (
        <div className="task-list">{visible.map(card)}</div>
      ) : (
        <div className="task-board">
          {columns
            .filter(([id]) => visible.some((task) => taskLane(task) === id))
            .map(([id, label]) => (
              <section key={id} className="task-lane">
                <h2>
                  {label}
                  <span>{visible.filter((task) => taskLane(task) === id).length}</span>
                </h2>
                {visible.filter((task) => taskLane(task) === id).map(card)}
              </section>
            ))}
        </div>
      )}
    </section>
  );
}
