import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { TaskPanel } from './TaskPanel';
import { TaskPicker } from './TaskPicker';
import { Icon } from './UI';
import { Modal } from './Modal';
import { TaskMonitor, needsDecision, isLive } from './TaskMonitor';
import { statusLabel } from './types';
import { taskViews, type Task, type TaskView } from './types';
import {
  minimumSize,
  panes,
  addPane,
  liveGroups,
  movePane,
  removeNode,
  seedPanes,
  splitNode,
  updateNode,
  type Node,
  type Pane,
  type Split,
  type Tab,
} from './deck';

function PaneView({
  node,
  number,
  tasks,
  onChange,
  onSplit,
  onRemove,
  focus,
  hidden,
  onFocus,
  onOpen,
  canSplit = true,
}: {
  node: Pane;
  number: number;
  tasks: Task[];
  onChange: (node: Pane) => void;
  onSplit: (direction: Split['direction']) => void;
  onRemove: () => void;
  focus: boolean;
  hidden: boolean;
  onFocus: () => void;
  onOpen: (id: string, tab: TaskView) => void;
  canSplit?: boolean;
}) {
  const task = tasks.find((item) => item.id === node.taskId);
  return (
    <section
      ref={(element) => {
        if (element) element.inert = hidden;
      }}
      className={`pane ${focus ? 'focused' : ''} ${!task ? 'pane-unassigned' : ''}`}
      data-view={node.view}
      aria-label={`Pane ${number}: ${task?.title || 'Choose a task'}`}
    >
      <header className="pane-header">
        <TaskPicker
          id={node.id}
          label={`Task for pane ${number}`}
          tasks={tasks}
          selected={node.taskId}
          onChange={(taskId) => onChange({ ...node, taskId })}
        />
        <div className="pane-actions">
          {task && (
            <button
              className="icon-button"
              onClick={() => onOpen(task.id, node.view)}
              aria-label="Open task page"
              title="Open task page"
            >
              <Icon name="external" size={16} />
            </button>
          )}
          {task && (
            <button
              className="icon-button"
              onClick={onFocus}
              aria-label={focus ? 'Restore' : 'Focus'}
              title={focus ? 'Restore grid' : 'Focus task'}
            >
              <Icon name="expand" size={16} />
            </button>
          )}
          <button
            className="icon-button"
            disabled={!canSplit}
            onClick={() => onSplit('horizontal')}
            aria-label="Split side by side"
            title="Split side by side"
          >
            <Icon name="split-horizontal" size={17} />
          </button>
          <button
            className="icon-button"
            disabled={!canSplit}
            onClick={() => onSplit('vertical')}
            aria-label="Split top and bottom"
            title="Split top and bottom"
          >
            <Icon name="split-vertical" size={17} />
          </button>
          <button
            className="icon-button"
            onClick={onRemove}
            aria-label="Close pane"
            title="Close pane"
          >
            <Icon name="close" size={17} />
          </button>
        </div>
      </header>
      {task ? (
        <>
          {node.view !== 'overview' && <h2 className="sr-only">{task.title}</h2>}
          <nav className="pane-tabs" aria-label={`Pane ${number} view`}>
            {taskViews.map((item) => (
              <button
                key={item.id}
                aria-pressed={node.view === item.id}
                onClick={() => onChange({ ...node, view: item.id })}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <TaskPanel key={`${task.id}:${node.view}`} task={task} view={node.view} />
        </>
      ) : (
        <div className="pane-empty">
          <p>Choose a task above to add it to this grid.</p>
        </div>
      )}
    </section>
  );
}
function Divider({
  node,
  update,
  enabled,
}: {
  node: Split;
  update: (id: string, fn: (node: Node) => Node) => void;
  enabled: boolean;
}) {
  const pointer = useRef<number | null>(null);
  const horizontal = node.direction === 'horizontal';
  function setRatio(ratio: number) {
    update(node.id, (current) =>
      current.type === 'split'
        ? { ...current, ratio: Math.max(20, Math.min(80, Math.round(ratio))) }
        : current,
    );
  }
  return (
    <div
      className="divider"
      role="separator"
      tabIndex={enabled ? 0 : -1}
      aria-label="Resize panes"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuenow={node.ratio}
      aria-valuemin={20}
      aria-valuemax={80}
      onKeyDown={(event) => {
        const minus = horizontal ? 'ArrowLeft' : 'ArrowUp',
          plus = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (event.key === minus || event.key === plus) {
          event.preventDefault();
          setRatio(node.ratio + (event.key === minus ? -5 : 5));
        }
      }}
      onPointerDown={(event) => {
        if (!enabled || event.button !== 0) return;
        event.preventDefault();
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (pointer.current !== event.pointerId) return;
        const rect = event.currentTarget.parentElement?.getBoundingClientRect();
        if (!rect) return;
        const size = horizontal ? rect.width : rect.height;
        if (size > 0)
          setRatio(
            (100 * (horizontal ? event.clientX - rect.left : event.clientY - rect.top)) / size,
          );
      }}
      onPointerUp={() => {
        pointer.current = null;
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      onLostPointerCapture={() => {
        pointer.current = null;
      }}
    />
  );
}
function Tree({
  node,
  paneOrder,
  tasks,
  focus,
  setFocus,
  update,
  remove,
  split,
  onOpen,
}: {
  node: Node;
  paneOrder: string[];
  tasks: Task[];
  focus: string;
  setFocus: (id: string) => void;
  update: (id: string, fn: (node: Node) => Node) => void;
  remove: (id: string) => void;
  split: (id: string, direction: Split['direction']) => void;
  onOpen: (id: string, tab: TaskView) => void;
}) {
  if (node.type === 'pane')
    return (
      <PaneView
        node={node}
        number={paneOrder.indexOf(node.id) + 1}
        tasks={tasks}
        onChange={(pane) => update(node.id, () => pane)}
        onSplit={(direction) => split(node.id, direction)}
        onRemove={() => remove(node.id)}
        focus={focus === node.id}
        hidden={!!focus && focus !== node.id}
        onFocus={() => setFocus(focus === node.id ? '' : node.id)}
        onOpen={onOpen}
        canSplit={paneOrder.length < 8}
      />
    );
  const child = { tasks, paneOrder, focus, setFocus, update, remove, split, onOpen };
  const horizontal = node.direction === 'horizontal',
    minimum = minimumSize(node);
  return (
    <div
      className={`split ${node.direction}`}
      style={
        horizontal
          ? {
              minWidth: minimum.width,
              minHeight: minimum.height,
              gridTemplateColumns: `${node.ratio}fr 8px ${100 - node.ratio}fr`,
            }
          : {
              minWidth: minimum.width,
              minHeight: minimum.height,
              gridTemplateRows: `${node.ratio}fr 8px ${100 - node.ratio}fr`,
            }
      }
    >
      <Tree node={node.first} {...child} />
      <Divider node={node} update={update} enabled={!focus} />
      <Tree node={node.second} {...child} />
    </div>
  );
}

export function TaskDeck({
  active,
  tabs,
  tasks,
  error,
  loading = false,
  focus,
  setFocus,
  spotlight = '',
  onSelect,
  onAdd,
  onRename,
  onClose,
  onUpdate,
  onOpen,
  onCreate,
}: {
  active: Tab;
  tabs: Tab[];
  tasks: Task[];
  error: string;
  loading?: boolean;
  focus: string;
  setFocus: (id: string) => void;
  // A task to bring into view and mark briefly, from "Open task deck" on its page.
  spotlight?: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: () => void;
  onClose: () => void;
  onUpdate: (patch: Partial<Tab>) => void;
  onOpen: (id: string, view: TaskView) => void;
  onCreate: () => void;
}) {
  const canvas = useRef<HTMLDivElement>(null),
    dragging = useRef('');
  const [announcement, setAnnouncement] = useState(''),
    [editing, setEditing] = useState(false),
    [peek, setPeek] = useState<{ taskId: string; view: TaskView } | null>(null),
    [now, setNow] = useState(Date.now);
  // Alternating the attribute restarts the fade when the workspace or its contents change,
  // without remounting tiles that hold drag and focus state.
  const view = `${active.id}:${active.mode}`;
  const [swap, setSwap] = useState({ view, count: 0 });
  if (swap.view !== view) setSwap({ view, count: swap.count + 1 });
  const live = active.mode === 'live',
    groups = live ? liveGroups(tasks, 6, spotlight) : [],
    items = panes(active.root),
    grid = live || active.layout !== 'split',
    watched = live
      ? groups.flatMap(([, , rows]) => rows)
      : items.flatMap((pane) => {
          const task = tasks.find((task) => task.id === pane.taskId);
          return task ? [task] : [];
        }),
    taskCount = watched.length,
    vacancy = items.find((pane) => !tasks.some((task) => task.id === pane.taskId)),
    full = items.length >= 8 && !vacancy,
    running = watched.some(isLive),
    expanded = live ? undefined : items.find((pane) => pane.id === focus),
    detailTask = tasks.find((task) => task.id === (live ? peek?.taskId : expanded?.taskId)),
    detailView = (live ? peek?.view : expanded?.view) || 'overview',
    waiting = watched.filter(needsDecision).length,
    working = watched.filter((task) => !needsDecision(task) && isLive(task)).length;
  useEffect(() => setPeek(null), [active.id, live]);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (focus) canvas.current?.scrollTo(0, 0);
  }, [focus]);
  const modify = (fn: (node: Node) => Node) => onUpdate({ root: fn(active.root) });
  // Bring the task asked for into view: a pinned grid gains a tile for it if it has none, then
  // the tile scrolls to the middle and glows for a moment. The request is used once.
  const spotlit = useRef('');
  useEffect(() => {
    if (!spotlight || spotlit.current === spotlight || !tasks.some((task) => task.id === spotlight))
      return;
    if (!live && !items.some((pane) => pane.taskId === spotlight)) {
      if (full) return;
      modify((root) =>
        vacancy
          ? updateNode(root, vacancy.id, () => ({ ...vacancy, taskId: spotlight }))
          : addPane(root, spotlight),
      );
      return;
    }
    const tile = canvas.current?.querySelector<HTMLElement>(
      `[data-task-id="${spotlight.replace(/[^a-zA-Z0-9-]/g, '')}"]`,
    );
    if (!tile) return;
    spotlit.current = spotlight;
    const motion = document.documentElement.dataset.lowMotion !== 'true';
    tile.scrollIntoView({ block: 'center', behavior: motion ? 'smooth' : 'instant' });
    tile.classList.add('is-spotlight');
    window.setTimeout(() => tile.classList.remove('is-spotlight'), 1800);
    history.replaceState(null, '', location.hash.replace(/[?&]task=[^&]*/, ''));
  });
  function reorder(from: string, to: string) {
    if (!items.some((pane) => pane.id === from) || !items.some((pane) => pane.id === to)) return;
    modify((root) => movePane(root, from, to));
    setAnnouncement(`Pane moved to position ${items.findIndex((pane) => pane.id === to) + 1}.`);
    dragging.current = '';
  }
  function split(id: string, direction: Split['direction']) {
    if (items.length >= 8) return;
    onUpdate({ layout: 'split', root: splitNode(active.root, id, direction) });
    setFocus('');
  }
  return (
    <section className="task-deck">
      <header className="deck-toolbar">
        <div className="deck-title">
          <h1>Task deck</h1>
          {(() => {
            const note = loading
              ? 'Loading…'
              : live
                ? [working && `${working} running`, !waiting && !working && 'Nothing running']
                    .filter(Boolean)
                    .join(' · ')
                : `${taskCount} watching`;
            return note ? <span>{note}</span> : null;
          })()}
        </div>
        {waiting > 0 && (
          <span className="deck-attention-count">
            {waiting} {waiting === 1 ? 'needs' : 'need'} you
          </span>
        )}
        <div className="segmented deck-mode" role="group" aria-label="Deck contents">
          <button
            aria-pressed={live}
            title="Shows what needs you and what is running, automatically"
            onClick={() => {
              setEditing(false);
              setFocus('');
              onUpdate({ mode: 'live' });
            }}
          >
            Live
            {live && <motion.span className="segmented-thumb" layoutId="deck-mode" />}
          </button>
          <button
            aria-pressed={!live}
            title="Shows only the tasks you pin"
            onClick={() => {
              if (!live) return;
              setFocus('');
              // A first visit starts from what the live deck is showing, not a blank grid.
              onUpdate(
                items.some((pane) => pane.taskId) || active.layout === 'split'
                  ? { mode: 'pinned' }
                  : { mode: 'pinned', root: seedPanes(watched.map((task) => task.id)) },
              );
            }}
          >
            Pinned
            {!live && <motion.span className="segmented-thumb" layoutId="deck-mode" />}
          </button>
        </div>
        {!live && !full && (
          <div className="deck-add-task">
            <TaskPicker
              id={`add-${active.id}`}
              label="Add task to grid"
              placeholder="+ Add task…"
              disabled={loading}
              tasks={tasks}
              selected=""
              onChange={(taskId) => {
                if (taskId) {
                  modify((root) =>
                    vacancy
                      ? updateNode(root, vacancy.id, () => ({ ...vacancy, taskId }))
                      : addPane(root, taskId),
                  );
                  setFocus('');
                }
              }}
            />
          </div>
        )}
        {!live && (
          <button
            className="deck-edit-toggle"
            aria-pressed={editing}
            onClick={() => setEditing((value) => !value)}
          >
            <Icon name={editing ? 'check' : 'settings'} size={15} />
            {editing ? 'Done editing' : 'Edit grid'}
          </button>
        )}
      </header>
      {error && (
        <p className="error" role="status">
          {error}
        </p>
      )}
      <nav className="workspace-tabs" aria-label="Workspaces" hidden={live && tabs.length === 1}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            aria-current={tab.id === active.id ? 'page' : undefined}
            onClick={() => onSelect(tab.id)}
          >
            {tab.name}
            {tab.id === active.id && (
              <motion.span className="scope-indicator" layoutId="deck-workspace-tab" />
            )}
          </button>
        ))}
        <button
          aria-label="Add workspace"
          title="Add workspace"
          disabled={tabs.length >= 10}
          onClick={onAdd}
        >
          <Icon name="plus" size={16} />
        </button>
        {editing && (
          <span className="workspace-controls">
            <button aria-label="Rename" title="Rename workspace" onClick={onRename}>
              <Icon name="edit" size={15} />
            </button>
            <button
              aria-label="Close tab"
              title="Close workspace"
              disabled={tabs.length <= 1}
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </button>
          </span>
        )}
      </nav>
      {editing && (
        <div className="deck-edit-tools">
          <div className="segmented deck-layout" role="group" aria-label="Grid layout">
            <button
              aria-pressed={grid && active.density !== 'fixed'}
              onClick={() => onUpdate({ layout: 'grid', density: 'auto' })}
            >
              Auto fit
            </button>
            {([1, 2, 3, 4] as const).map((columns) => (
              <button
                key={columns}
                aria-label={`${columns} column${columns > 1 ? 's' : ''}`}
                aria-pressed={grid && active.density === 'fixed' && active.columns === columns}
                onClick={() => onUpdate({ layout: 'grid', density: 'fixed', columns })}
              >
                {columns}
              </button>
            ))}
            <button
              aria-pressed={!grid}
              onClick={() => {
                onUpdate({ layout: 'split' });
                setFocus('');
              }}
            >
              Freeform
            </button>
          </div>
          <span>Drag tiles to reorder.</span>
        </div>
      )}
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <div
        ref={canvas}
        className={`canvas deck-canvas ${grid ? 'is-grid' : 'is-freeform'}`}
        data-swap={swap.count ? swap.count % 2 : undefined}
      >
        {loading ? (
          <p role="status" className="form-note">
            Loading tasks…
          </p>
        ) : live ? (
          groups.length ? (
            groups.map(([id, label, rows]) => (
              <section key={id} className="deck-group" aria-label={label}>
                <h2>
                  {label} <span>{rows.length}</span>
                </h2>
                <div className="deck-monitor-grid" data-columns="auto">
                  {rows.map((task, index) => (
                    <TaskMonitor
                      key={task.id}
                      node={{ type: 'pane', id: task.id, taskId: task.id, view: 'overview' }}
                      number={index + 1}
                      task={task}
                      tasks={tasks}
                      editing={false}
                      now={now}
                      onChange={() => {}}
                      onExpand={(view) => setPeek({ taskId: task.id, view })}
                      onRemove={() => {}}
                      onDrag={() => {}}
                      onDrop={() => {}}
                      onMove={() => {}}
                    />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <div className="deck-empty">
              <p>
                {tasks.length
                  ? 'Nothing is running or waiting on you.'
                  : 'Tasks appear here on their own as soon as you create one.'}
              </p>
              <button className="primary" onClick={onCreate}>
                <Icon name="plus" size={15} />
                New task
              </button>
            </div>
          )
        ) : grid ? (
          <div
            className="deck-monitor-grid"
            data-columns={active.density === 'fixed' ? active.columns || 3 : 'auto'}
          >
            {items.map((node, index) =>
              editing || tasks.some((task) => task.id === node.taskId) ? (
                <TaskMonitor
                  key={node.id}
                  node={node}
                  number={index + 1}
                  task={tasks.find((task) => task.id === node.taskId)}
                  tasks={tasks}
                  editing={editing}
                  now={now}
                  onChange={(taskId) =>
                    modify((root) => updateNode(root, node.id, () => ({ ...node, taskId })))
                  }
                  onExpand={(view) => {
                    modify((root) => updateNode(root, node.id, () => ({ ...node, view })));
                    setFocus(node.id);
                  }}
                  onRemove={() => {
                    modify((root) => removeNode(root, node.id));
                    setFocus('');
                  }}
                  onDrag={(id) => {
                    dragging.current = id;
                  }}
                  onDrop={(id) => reorder(dragging.current, id)}
                  onMove={(offset) => {
                    const target = items[index + offset];
                    if (target) reorder(node.id, target.id);
                  }}
                />
              ) : null,
            )}
            {!editing && !watched.length && (
              <div className="deck-empty">
                <p>Add tasks to monitor.</p>
              </div>
            )}
          </div>
        ) : (
          <Tree
            node={active.root}
            paneOrder={items.map((pane) => pane.id)}
            tasks={tasks}
            focus={focus}
            setFocus={setFocus}
            update={(id, fn) => modify((root) => updateNode(root, id, fn))}
            remove={(id) => {
              modify((root) => removeNode(root, id));
              setFocus('');
            }}
            split={split}
            onOpen={onOpen}
          />
        )}
      </div>
      {grid && detailTask && (
        <Modal
          title={detailTask.title}
          className="deck-detail-modal"
          onClose={() => (live ? setPeek(null) : setFocus(''))}
        >
          <div className="deck-detail-toolbar">
            <span>{statusLabel(detailTask.status)}</span>
            <button onClick={() => onOpen(detailTask.id, detailView)}>
              <Icon name="external" size={14} />
              Open task
            </button>
          </div>
          <nav className="pane-tabs" aria-label="Task detail view">
            {taskViews.map((item) => (
              <button
                key={item.id}
                aria-pressed={detailView === item.id}
                onClick={() =>
                  expanded
                    ? modify((root) =>
                        updateNode(root, expanded.id, () => ({ ...expanded, view: item.id })),
                      )
                    : setPeek({ taskId: detailTask.id, view: item.id })
                }
              >
                {item.label}
              </button>
            ))}
          </nav>
          <TaskPanel key={`${detailTask.id}:${detailView}`} task={detailTask} view={detailView} />
        </Modal>
      )}
    </section>
  );
}
