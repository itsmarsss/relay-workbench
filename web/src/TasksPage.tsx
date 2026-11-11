import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { createPortal } from 'react-dom';
import type { Task } from './types';
import {
  columns,
  taskLane,
  boardFilters,
  filteredTasks,
  taskScopes,
  inTaskScope,
  foldedLanes,
  toggleLane,
} from './board';
import { Select, Icon, ProviderIcon } from './UI';
import { Notice, useMutation } from './Session';
import { Modal } from './Modal';
import { ago, nextStep, repositoryNames, stageNote, ticketRef, waitingKind } from './presentation';
export { taskLane } from './board';
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
function currentFilters() {
  let layout: 'board' | 'list' = 'list',
    showEmpty = false;
  try {
    layout = localStorage.getItem('relay-task-layout') === 'board' ? 'board' : 'list';
    showEmpty = localStorage.getItem('relay-task-show-empty-v2') === 'true';
  } catch {}
  return boardFilters(typeof location === 'undefined' ? '' : location.hash, { layout, showEmpty });
}
function savedFolds() {
  try {
    return foldedLanes(localStorage.getItem('relay-task-folded-stages'));
  } catch {
    return [];
  }
}
export function TasksPage({
  tasks,
  onOpen,
  onCreate,
  loading = false,
}: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  loading?: boolean;
}) {
  const [filters, setFilters] = useState(currentFilters),
    [dragging, setDragging] = useState(''),
    [target, setTarget] = useState(''),
    [menu, setMenu] = useState<{ task: Task; x: number; y: number; move?: boolean } | null>(null),
    [deleting, setDeleting] = useState<Task | null>(null),
    [folded, setFolded] = useState(savedFolds);
  const mutation = useMutation();
  const menuPanel = useRef<HTMLDivElement>(null),
    menuTrigger = useRef<HTMLElement | null>(null);
  function closeMenu(restoreFocus = true) {
    setMenu(null);
    if (restoreFocus) menuTrigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    const follow = () => setFilters(currentFilters());
    window.addEventListener('hashchange', follow);
    window.addEventListener('popstate', follow);
    return () => {
      window.removeEventListener('hashchange', follow);
      window.removeEventListener('popstate', follow);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('relay-task-layout', filters.layout);
      localStorage.setItem('relay-task-show-empty-v2', String(filters.showEmpty));
    } catch {}
  }, [filters.layout, filters.showEmpty]);
  function fold(lane: string) {
    const next = toggleLane(folded, lane);
    setFolded(next);
    try {
      localStorage.setItem('relay-task-folded-stages', JSON.stringify(next));
    } catch {}
  }
  useClientLayoutEffect(() => {
    if (!menu || !menuPanel.current) return;
    const panel = menuPanel.current,
      bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - bounds.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - bounds.height - 8))}px`;
    panel.style.visibility = 'visible';
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    menuPanel.current
      ?.querySelector<HTMLElement>(menu.move ? '.select-trigger' : 'button')
      ?.focus({ preventScroll: true });
    const close = (event: Event) => {
      if (event.target instanceof Node && menuPanel.current?.contains(event.target)) return;
      closeMenu(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  function filter(patch: Partial<typeof filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    const p = new URLSearchParams();
    if (next.query) p.set('q', next.query);
    if (next.repository) p.set('repo', next.repository);
    p.set('view', next.layout);
    if (next.scope !== 'all') p.set('scope', next.scope);
    if (next.stage) p.set('stage', next.stage);
    if (next.sort !== 'priority') p.set('sort', next.sort);
    p.set('empty', next.showEmpty ? '1' : '0');
    history.replaceState(null, '', '#tasks' + (p.size ? '?' + p.toString() : ''));
  }
  const visible = filteredTasks(tasks, filters);
  const populated = columns.filter(([lane]) => visible.some((task) => taskLane(task) === lane));
  // The board never reflows mid-drag; every stage stays reachable from the dock instead.
  const lanes = filters.showEmpty || tasks.length === 0 ? columns : populated;
  const dragged = tasks.find((task) => task.id === dragging);
  // Zones only claim the highlight; the page clears it once the pointer is over none of them,
  // so crossing a zone's own children never flickers.
  const dropZone = (id: string, lane: string) => {
    const claim = (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (target !== id) setTarget(id);
    };
    return {
      'data-drop-zone': id,
      onDragEnter: claim,
      onDragOver: claim,
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDragging('');
        setTarget('');
        if (dragged) void move(dragged, lane);
      },
    };
  };
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
      layout={!dragging}
      key={task.id}
      className={`task-card ${filters.layout === 'board' ? 'board-task-card' : ''} ${dragging === task.id ? 'is-dragging' : ''}`}
      data-lane={taskLane(task)}
      draggable={!mutation.busy}
      onDragStartCapture={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(task.id);
      }}
      onDragEndCapture={() => {
        setDragging('');
        setTarget('');
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        menuTrigger.current = e.currentTarget.querySelector('.card-menu');
        setMenu({
          task,
          x: e.clientX,
          y: e.clientY,
        });
      }}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() !== 'm' || event.ctrlKey || event.metaKey || event.altKey)
          return;
        event.preventDefault();
        menuTrigger.current = event.currentTarget.querySelector('.card-menu');
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenu({ task, x: bounds.left + 20, y: bounds.top + 20, move: true });
      }}
    >
      <button className="task-card-open" onClick={() => onOpen(task.id)}>
        {filters.layout === 'board' ? (
          <>
            <strong className="board-task-title" title={task.title}>
              {task.title}
            </strong>
            <span className="board-task-repository">
              <Icon name="repository" size={13} />
              <span>{repositoryNames(task)}</span>
              {ticketRef(task.ticket).startsWith('#') && <span>{ticketRef(task.ticket)}</span>}
            </span>
            {(task.error || task.latestSummary) && (
              <span className={`task-card-summary ${task.error ? 'is-error' : ''}`}>
                {task.error || task.latestSummary}
              </span>
            )}
            <span className="board-task-next">
              <span>
                {task.statusOverride
                  ? 'Manual status'
                  : stageNote(task)
                    ? `${waitingKind(task)} · ${stageNote(task)}`
                    : nextStep(task)}
              </span>
              {task.currentRun?.harness && (
                <ProviderIcon provider={task.currentRun.harness} size={17} />
              )}
              <time>{ago(task.updatedAt)}</time>
            </span>
          </>
        ) : (
          <>
            <span className="task-card-copy">
              <strong>{task.title}</strong>
              <small>
                {repositoryNames(task)}
                {ticketRef(task.ticket) && ` · ${ticketRef(task.ticket)}`}
                {stageNote(task) && ` · ${stageNote(task)}`}
              </small>
              {(task.error || task.latestSummary) && (
                <span className="task-card-summary">{task.error || task.latestSummary}</span>
              )}
            </span>
            <span className="task-card-state">
              <span className={`task-status status-${task.statusOverride?.value || task.status}`}>
                {columns.find((row) => row[0] === taskLane(task))?.[1]}
              </span>
              <strong>{nextStep(task)}</strong>
              <time>{ago(task.updatedAt)}</time>
            </span>
            <span className="task-card-chevron">
              <Icon name="chevron" size={18} />
            </span>
          </>
        )}
      </button>
      <button
        className="icon-button card-menu"
        aria-label={`Actions for ${task.title}`}
        onClick={(e) => {
          menuTrigger.current = e.currentTarget;
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({
            task,
            x: r.left,
            y: r.bottom + 4,
          });
        }}
      >
        <Icon name="more" />
      </button>
    </motion.article>
  );
  return (
    <section
      className="tasks-page"
      aria-busy={loading}
      onDragOver={(e) => {
        if (target && !(e.target as Element).closest('[data-drop-zone]')) setTarget('');
      }}
    >
      <div className="page-title">
        <div>
          <h1>Tasks</h1>
        </div>
        <div className="segmented task-layout-switch" role="group" aria-label="Task layout">
          {(['board', 'list'] as const).map((layout) => (
            <button
              key={layout}
              aria-pressed={filters.layout === layout}
              onClick={() => filter({ layout })}
            >
              <Icon name={layout === 'board' ? 'board' : 'list'} size={16} />
              {layout === 'board' ? 'Board' : 'List'}
              {filters.layout === layout && (
                <motion.span className="segmented-thumb" layoutId="task-layout" />
              )}
            </button>
          ))}
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
          <span className="sr-only">Repository</span>
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
          <span className="sr-only">Stage</span>
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
          <span className="sr-only">Sort</span>
          <Select
            label="Sort tasks"
            value={filters.sort}
            options={[
              { value: 'priority', label: 'Sort: Needs you first' },
              { value: 'recent', label: 'Sort: Recently updated' },
              { value: 'title', label: 'Sort: Title' },
            ]}
            onChange={(sort) => filter({ sort })}
          />
        </label>
      </div>
      <div className="task-results-toolbar">
        <p role="status">
          {loading ? 'Loading tasks…' : `${visible.length} of ${tasks.length} tasks`}
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
        </div>
      </div>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {loading ? null : tasks.length === 0 && filters.layout !== 'board' ? (
        <div className="empty-state">
          <h2>No tasks yet</h2>
          <p>Create a draft to add requirements and repositories.</p>
          <button className="primary" onClick={onCreate}>
            <Icon name="plus" size={16} />
            Create task
          </button>
        </div>
      ) : tasks.length > 0 &&
        !visible.length &&
        (filters.layout !== 'board' || !filters.showEmpty) ? (
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
        <div className="task-board-workspace">
          <motion.div className="task-board" role="region" aria-label="Task board">
            {lanes.map(([lane, label]) => {
              const rows = visible.filter((task) => taskLane(task) === lane);
              // An empty workspace keeps every stage open so the create action stays in view.
              const isFolded = tasks.length > 0 && folded.includes(lane);
              return (
                <section
                  key={lane}
                  data-lane={lane}
                  data-populated={rows.length > 0}
                  aria-label={`${label} column`}
                  className={`task-lane ${isFolded ? 'is-folded' : ''} ${target === lane ? 'drop-target' : ''}`}
                  {...dropZone(lane, lane)}
                >
                  {isFolded ? (
                    <button
                      className="board-lane-strip"
                      aria-expanded={false}
                      aria-label={`Expand ${label}, ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`}
                      title={`Expand ${label}`}
                      onClick={() => fold(lane)}
                    >
                      <span className={`lane-dot lane-dot-${lane}`} aria-hidden="true" />
                      <span className="lane-count">{rows.length}</span>
                      <span className="board-lane-strip-label">{label}</span>
                    </button>
                  ) : (
                    <>
                      <header className="board-lane-heading">
                        <h2>
                          <span>
                            <span className={`lane-dot lane-dot-${lane}`} aria-hidden="true" />
                            {label}
                          </span>
                          <span className="lane-count">{rows.length}</span>
                        </h2>
                        {tasks.length > 0 && (
                          <button
                            className="icon-button board-lane-fold"
                            aria-expanded
                            aria-label={`Collapse ${label}`}
                            title={`Collapse ${label}`}
                            onClick={() => fold(lane)}
                          >
                            <Icon name="fold" size={14} />
                          </button>
                        )}
                      </header>
                      {rows.map(card)}
                      {tasks.length === 0 && lane === 'backlog' && (
                        <button className="board-create-task" onClick={onCreate}>
                          <Icon name="plus" size={16} /> Create task
                        </button>
                      )}
                      {!rows.length && tasks.length > 0 && (
                        <p className="board-lane-empty">No tasks</p>
                      )}
                    </>
                  )}
                </section>
              );
            })}
            {/* Zero-height spacers keep a wrapped last row at the same stage width as a full row. */}
            {Array.from({ length: 8 }, (_, index) => (
              <span key={index} className="task-lane-spacer" aria-hidden="true" />
            ))}
          </motion.div>
        </div>
      )}
      {dragged && (
        <div className="stage-dock" role="group" aria-label="Move to stage">
          <p>
            Drop on a stage to move <strong>{dragged.title}</strong>
          </p>
          <div className="stage-dock-targets">
            {columns.map(([lane, label]) => (
              <div
                key={lane}
                className={`stage-dock-target ${target === `dock:${lane}` ? 'drop-target' : ''}`}
                aria-label={`Move to ${label}`}
                aria-current={taskLane(dragged) === lane ? 'true' : undefined}
                {...dropZone(`dock:${lane}`, lane)}
              >
                <span className={`lane-dot lane-dot-${lane}`} aria-hidden="true" />
                {label}
              </div>
            ))}
          </div>
        </div>
      )}
      {menu &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuPanel}
            className="task-context-menu surface"
            role="dialog"
            aria-label="Task actions"
            data-popover-container="true"
            style={{ left: menu.x, top: menu.y, visibility: 'hidden' }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
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
              className="danger"
              onClick={() => {
                setDeleting(menu.task);
                setMenu(null);
              }}
            >
              Delete task
            </button>
          </div>,
          document.body,
        )}
      {deleting && (
        <Modal
          title="Delete task?"
          returnFocus={menuTrigger.current}
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
