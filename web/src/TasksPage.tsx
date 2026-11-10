import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { Task } from './types';
import { columns, taskLane, boardFilters, filteredTasks, taskScopes, inTaskScope } from './board';
import { Select, Icon, ProviderName } from './UI';
import { Notice, useMutation } from './Session';
import { Modal } from './Modal';
export { taskLane } from './board';
export function TasksPage({
  tasks,
  onOpen,
  onCreate,
}: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [filters, setFilters] = useState(() =>
      boardFilters(typeof location === 'undefined' ? '' : location.hash),
    ),
    [dragging, setDragging] = useState(''),
    [target, setTarget] = useState(''),
    [menu, setMenu] = useState<{ task: Task; x: number; y: number } | null>(null),
    [deleting, setDeleting] = useState<Task | null>(null);
  const mutation = useMutation();
  useEffect(() => {
    const follow = () => setFilters(boardFilters(location.hash));
    window.addEventListener('hashchange', follow);
    window.addEventListener('popstate', follow);
    return () => {
      window.removeEventListener('hashchange', follow);
      window.removeEventListener('popstate', follow);
    };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key);
    };
  }, [menu]);
  function filter(patch: Partial<typeof filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    const p = new URLSearchParams();
    if (next.query) p.set('q', next.query);
    if (next.repository) p.set('repo', next.repository);
    if (next.layout === 'board') p.set('view', 'board');
    if (next.scope !== 'all') p.set('scope', next.scope);
    if (next.stage) p.set('stage', next.stage);
    if (next.sort !== 'priority') p.set('sort', next.sort);
    if (next.showEmpty) p.set('empty', '1');
    history.replaceState(null, '', '#tasks' + (p.size ? '?' + p.toString() : ''));
  }
  const visible = filteredTasks(tasks, filters);
  const repositories = [
    ...new Map(
      tasks
        .flatMap((t) => [t.repository, ...(t.repositories || []).map((row) => row.repository)])
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => [r.id, r]),
    ).values(),
  ];
  async function move(task: Task, lane: string) {
    const column = columns.find((row) => row[0] === lane);
    if (!column || taskLane(task) === lane) return;
    try {
      await mutation.run(`/api/tasks/${task.id}/status-override`, {
        taskRevision: task.taskRevision,
        value: column[2],
        lane,
      });
    } catch {}
  }
  const card = (task: Task) => (
    <motion.article
      layout
      key={task.id}
      className="task-card"
      draggable={!mutation.busy}
      onDragStart={(e) => {
        if ('dataTransfer' in e) (e.dataTransfer as DataTransfer)?.setData('text/plain', task.id);
        setDragging(task.id);
      }}
      onDragEnd={() => {
        setDragging('');
        setTarget('');
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({
          task,
          x: Math.min(e.clientX, window.innerWidth - 220),
          y: Math.min(e.clientY, window.innerHeight - 290),
        });
      }}
    >
      <button className="task-card-open" onClick={() => onOpen(task.id)}>
        <span className="task-card-copy">
          <strong>{task.title}</strong>
          <small>
            {task.repository?.name || 'Unspecified'}
            {(task.repositories?.length || 0) > 1 && ` +${task.repositories!.length - 1}`}
            {task.ticket &&
              ` · ${task.ticket.match(/\/issues\/(\d+)/)?.[1] ? '#' + task.ticket.match(/\/issues\/(\d+)/)![1] : task.ticket}`}
          </small>
          {(task.error || task.latestSummary) && (
            <span className="task-card-summary">{task.error || task.latestSummary}</span>
          )}
        </span>
        <span className="task-card-state">
          <span className={`task-status status-${task.statusOverride?.value || task.status}`}>
            {columns.find((row) => row[0] === taskLane(task))?.[1]}
          </span>
          {task.currentRun?.harness && (
            <ProviderName provider={task.currentRun.harness} size={20} />
          )}
          <span className="task-reference">{task.id.slice(0, 8)}</span>
        </span>
        <span className="task-card-chevron">
          <Icon name="chevron" size={18} />
        </span>
      </button>
      <button
        className="icon-button card-menu"
        aria-label={`Actions for ${task.title}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({
            task,
            x: Math.min(r.left, window.innerWidth - 220),
            y: Math.min(r.bottom, window.innerHeight - 290),
          });
        }}
      >
        <Icon name="more" />
      </button>
    </motion.article>
  );
  return (
    <section className="tasks-page">
      <div className="page-title">
        <div>
          <h1>All tasks</h1>
          <p>Your work, from investigation to final approval.</p>
        </div>
      </div>
      <nav className="task-scopes" aria-label="Task status filters">
        {taskScopes.map(([scope, label]) => (
          <button
            key={scope}
            aria-pressed={filters.scope === scope}
            onClick={() => filter({ scope })}
          >
            {label}
            <span>{tasks.filter((task) => inTaskScope(task, scope)).length}</span>
            {filters.scope === scope && (
              <motion.span className="scope-indicator" layoutId="task-scope" />
            )}
          </button>
        ))}
      </nav>
      <div className="task-filters">
        <label className="task-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search title, repository, or issue…"
            value={filters.query}
            onChange={(e) => filter({ query: e.target.value })}
          />
        </label>
        <label className="task-filter-field">
          Repository
          <Select
            label="Filter repository"
            value={filters.repository}
            options={[
              { value: '', label: 'All repositories' },
              ...repositories.map((r) => ({ value: r.id, label: r.name })),
            ]}
            onChange={(repository) => filter({ repository })}
          />
        </label>
        <label className="task-filter-field">
          Stage
          <Select
            label="Filter stage"
            value={filters.stage}
            options={[
              { value: '', label: 'All stages' },
              ...columns.map(([value, label]) => ({ value, label })),
            ]}
            onChange={(stage) => filter({ stage })}
          />
        </label>
        <label className="task-filter-field">
          Sort
          <Select
            label="Sort tasks"
            value={filters.sort}
            options={[
              { value: 'priority', label: 'Next action' },
              { value: 'recent', label: 'Recently updated' },
              { value: 'title', label: 'Title' },
            ]}
            onChange={(sort) => filter({ sort })}
          />
        </label>
      </div>
      <div className="task-results-toolbar">
        <p role="status">
          {visible.length} of {tasks.length} tasks
        </p>
        <div className="inline">
          {(filters.query || filters.repository || filters.stage || filters.scope !== 'all') && (
            <button
              className="text-button"
              onClick={() => filter({ query: '', repository: '', stage: '', scope: 'all' })}
            >
              Clear filters
            </button>
          )}
          {filters.layout === 'board' && (
            <label className="inline">
              <input
                type="checkbox"
                checked={filters.showEmpty}
                onChange={(e) => filter({ showEmpty: e.target.checked })}
              />
              Empty stages
            </label>
          )}
          <div className="segmented" role="group" aria-label="Task layout">
            {(['list', 'board'] as const).map((layout) => (
              <button
                key={layout}
                aria-pressed={filters.layout === layout}
                onClick={() => filter({ layout })}
              >
                <Icon name={layout === 'board' ? 'grid' : 'list'} size={15} />
                {layout === 'board' ? 'Board' : 'List'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {tasks.length === 0 ? (
        <div className="empty-state">
          <h2>No tasks yet</h2>
          <p>Create a draft to add requirements and repositories.</p>
          <button className="primary" onClick={onCreate}>
            <Icon name="plus" size={16} />
            Create task
          </button>
        </div>
      ) : !visible.length ? (
        <div className="empty-state">
          <Icon name="search" size={28} />
          <h2>No matching tasks</h2>
          <p>Try another filter or clear your search.</p>
          <button onClick={() => filter({ query: '', repository: '', stage: '', scope: 'all' })}>
            Clear filters
          </button>
        </div>
      ) : filters.layout === 'list' ? (
        <div className="task-list">{visible.map(card)}</div>
      ) : (
        <div className="task-board">
          {columns
            .filter(
              ([lane]) =>
                filters.showEmpty || dragging || visible.some((task) => taskLane(task) === lane),
            )
            .map(([lane, label]) => (
              <section
                key={lane}
                className={`task-lane ${target === lane ? 'drop-target' : ''}`}
                onDragOver={(e) => {
                  if (dragging) {
                    e.preventDefault();
                    setTarget(lane);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const task = tasks.find((t) => t.id === dragging);
                  setDragging('');
                  setTarget('');
                  if (task) void move(task, lane);
                }}
              >
                <h2>
                  {label}
                  <span>{visible.filter((t) => taskLane(t) === lane).length}</span>
                </h2>
                {visible.filter((t) => taskLane(t) === lane).map(card)}
                <div className="lane-drop-hint">{dragging ? 'Move here' : ''}</div>
              </section>
            ))}
        </div>
      )}
      {menu && (
        <div
          className="task-context-menu surface"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              onOpen(menu.task.id);
              setMenu(null);
            }}
          >
            Open task
          </button>
          <Select
            label="Move to column"
            value={taskLane(menu.task)}
            options={columns.map(([value, label]) => ({ value, label }))}
            onChange={(lane) => {
              void move(menu.task, lane);
              setMenu(null);
            }}
          />
          {menu.task.statusOverride && (
            <button
              role="menuitem"
              onClick={() => {
                void mutation
                  .run(`/api/tasks/${menu.task.id}/status-override`, {
                    taskRevision: menu.task.taskRevision,
                    value: null,
                  })
                  .catch(() => {});
                setMenu(null);
              }}
            >
              Follow workflow status
            </button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setDeleting(menu.task);
              setMenu(null);
            }}
          >
            Delete task
          </button>
        </div>
      )}
      {deleting && (
        <Modal
          title="Delete task?"
          onClose={() => {
            if (!mutation.busy) setDeleting(null);
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation
              .run(`/api/tasks/${deleting.id}`, { taskRevision: deleting.taskRevision }, 'DELETE')
              .then(() => setDeleting(null))
              .catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button className="danger" disabled={mutation.busy}>
                Delete task
              </button>
            </>
          }
        >
          <p>Delete “{deleting.title}” and its activity? Workspace files are retained.</p>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </section>
  );
}
