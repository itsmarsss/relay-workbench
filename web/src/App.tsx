import { useEffect, useRef, useState } from 'react';
import {
  emptyPane,
  newDeck,
  minimumSize,
  panes,
  parseDeck,
  removeNode,
  splitNode,
  updateNode,
  type Deck,
  type Node,
  type Pane,
  type Split,
} from './deck';
import {
  taskViews,
  type Task,
  type RelayConfig,
  type RepositoryProfile,
  type TaskView,
} from './types';
import { TaskPanel } from './TaskPanel';
import { TaskPicker } from './TaskPicker';
import { useRelay } from './useRelay';
import { DraftComposer } from './DraftComposer';
import { RepositoryEditor } from './RepositoryEditor';
import { RepositoriesPage } from './RepositoriesPage';
import { TasksPage } from './TasksPage';
import { TaskPage } from './TaskPage';
import { StoragePage } from './StoragePage';
import { useStorage } from './useStorage';
import { parseRoute } from './route';

const storageKey = 'relay-react-deck-v1';
function initialDeck(): Deck {
  try {
    const result = parseDeck(localStorage.getItem(storageKey));
    const requested = new URLSearchParams(location.hash.split('?')[1]).get('tab');
    if (result.tabs.some((tab) => tab.id === requested)) result.active = requested!;
    return result;
  } catch {
    return newDeck();
  }
}
function PaneView({
  node,
  tasks,
  onChange,
  onSplit,
  onRemove,
  focus,
  hidden,
  onFocus,
  onOpen,
}: {
  node: Pane;
  tasks: Task[];
  onChange: (node: Pane) => void;
  onSplit: (direction: Split['direction']) => void;
  onRemove: () => void;
  focus: boolean;
  hidden: boolean;
  onFocus: () => void;
  onOpen: (id: string, tab: TaskView) => void;
}) {
  const task = tasks.find((item) => item.id === node.taskId);
  return (
    <section
      ref={(element) => {
        if (element) element.inert = hidden;
      }}
      className={`pane ${focus ? 'focused' : ''}`}
      aria-label={task?.title || 'Empty pane'}
    >
      <header className="pane-header">
        <TaskPicker
          id={node.id}
          tasks={tasks}
          selected={node.taskId}
          onChange={(taskId) => onChange({ ...node, taskId })}
        />
        <div className="pane-actions">
          {task && (
            <button
              onClick={() => onOpen(task.id, node.view)}
              aria-label="Open task page"
              title="Open task page"
            >
              ↗
            </button>
          )}
          <button onClick={onFocus}>{focus ? 'Restore' : 'Focus'}</button>
          <button onClick={() => onSplit('horizontal')} aria-label="Split side by side">
            ◫
          </button>
          <button onClick={() => onSplit('vertical')} aria-label="Split top and bottom">
            ⊟
          </button>
          <button onClick={onRemove} aria-label="Close pane">
            ×
          </button>
        </div>
      </header>
      {task ? (
        <>
          <nav className="pane-tabs" aria-label="Pane view">
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
          <strong>Choose a task</strong>
          <p>Task data appears here.</p>
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
  tasks,
  focus,
  setFocus,
  update,
  remove,
  split,
  onOpen,
}: {
  node: Node;
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
        tasks={tasks}
        onChange={(pane) => update(node.id, () => pane)}
        onSplit={(direction) => split(node.id, direction)}
        onRemove={() => remove(node.id)}
        focus={focus === node.id}
        hidden={!!focus && focus !== node.id}
        onFocus={() => setFocus(focus === node.id ? '' : node.id)}
        onOpen={onOpen}
      />
    );
  const child = { tasks, focus, setFocus, update, remove, split, onOpen };
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
export default function App() {
  const { tasks, bootstrap, connected, error, create, updateConfig } = useRelay(),
    [deck, setDeck] = useState(initialDeck),
    [focus, setFocus] = useState(''),
    [modal, setModal] = useState<{ kind: 'rename' | 'close'; tabId: string } | null>(null),
    [tabName, setTabName] = useState(''),
    [route, setRoute] = useState(() =>
      parseRoute(typeof location === 'undefined' ? '' : location.hash),
    ),
    [draftOpen, setDraftOpen] = useState(false),
    [repoEditor, setRepoEditor] = useState<{
      config: RelayConfig;
      revision: string;
      profile?: RepositoryProfile;
    } | null>(null);
  const storage = useStorage();
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const active = deck.tabs.find((tab) => tab.id === deck.active) || deck.tabs[0]!;
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(deck));
    } catch {}
  }, [deck]);
  useEffect(() => {
    if (focus) canvas.current?.scrollTo(0, 0);
  }, [focus]);
  useEffect(() => {
    const element = dialog.current;
    if (modal && element && !element.open) element.showModal();
    if (!modal && element?.open) element.close();
  }, [modal]);
  useEffect(() => {
    function followURL() {
      setRoute(parseRoute(location.hash));
      const requested = new URLSearchParams(location.hash.split('?')[1]).get('tab');
      setDeck((current) =>
        current.tabs.some((tab) => tab.id === requested)
          ? { ...current, active: requested! }
          : current,
      );
      setFocus('');
    }
    window.addEventListener('popstate', followURL);
    window.addEventListener('hashchange', followURL);
    return () => {
      window.removeEventListener('popstate', followURL);
      window.removeEventListener('hashchange', followURL);
    };
  }, []);
  function navigate(hash: string) {
    history.pushState(null, '', hash);
    setRoute(parseRoute(hash));
    setModal(null);
  }
  function editRepository(profile?: RepositoryProfile) {
    if (!bootstrap) return;
    setRepoEditor({
      config: structuredClone(bootstrap.config),
      revision: bootstrap.configRevision,
      ...(profile ? { profile: structuredClone(profile) } : {}),
    });
  }
  function selectTab(id: string) {
    setDeck((current) => ({ ...current, active: id }));
    setFocus('');
    history.pushState(null, '', `#deck?tab=${encodeURIComponent(id)}`);
    setRoute({ kind: 'deck' });
  }
  function modify(fn: (node: Node) => Node) {
    setDeck((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === current.active ? { ...tab, root: fn(tab.root) } : tab,
      ),
    }));
  }
  return (
    <div className="app">
      <aside>
        <div className="brand">relay</div>
        <p>Experimental migration</p>
        <nav className="app-nav">
          <button
            aria-current={route.kind === 'deck' ? 'page' : undefined}
            onClick={() => navigate(`#deck?tab=${encodeURIComponent(deck.active)}`)}
          >
            Task deck
          </button>
          <button
            aria-current={route.kind === 'tasks' || route.kind === 'task' ? 'page' : undefined}
            onClick={() => navigate('#tasks')}
          >
            All tasks <span>{tasks.length}</span>
          </button>
          <button
            aria-current={route.kind === 'repositories' ? 'page' : undefined}
            onClick={() => navigate('#repositories')}
          >
            Repositories
          </button>
          <button
            aria-current={route.kind === 'storage' ? 'page' : undefined}
            onClick={() => navigate('#storage')}
          >
            Storage
          </button>
        </nav>
        {storage.report && ['warning', 'critical'].includes(storage.report.pressure.state) && (
          <button className="storage-alert" onClick={() => navigate('#storage')}>
            Low disk space
          </button>
        )}
        <div className="connection">● {connected ? 'Connected' : 'Reconnecting'}</div>
      </aside>
      <main className={route.kind === 'deck' ? 'deck-main' : 'page-main'}>
        {storage.report && ['warning', 'critical'].includes(storage.report.pressure.state) && (
          <button className="mobile-storage-alert" onClick={() => navigate('#storage')}>
            Low disk space · Review storage
          </button>
        )}
        {route.kind === 'deck' ? (
          <>
            <header>
              <div>
                <h1>Task deck</h1>
                <p>Watch tasks side by side.</p>
              </div>
              <div className="page-header-actions">
                <span className="preview">Migration in progress</span>
                <button
                  className="primary"
                  disabled={!bootstrap}
                  onClick={() => setDraftOpen(true)}
                >
                  New task
                </button>
              </div>
            </header>
            {error && (
              <div className="error" role="status">
                {error}
              </div>
            )}
            <nav className="workspace-tabs" aria-label="Workspaces">
              {deck.tabs.map((tab) => (
                <button
                  key={tab.id}
                  aria-current={tab.id === deck.active ? 'page' : undefined}
                  onClick={() => {
                    selectTab(tab.id);
                  }}
                >
                  {tab.name}
                </button>
              ))}
              <button
                aria-label="Add workspace"
                disabled={deck.tabs.length >= 10}
                onClick={() => {
                  const tab = {
                    id: crypto.randomUUID(),
                    name: `Workspace ${deck.tabs.length + 1}`,
                    root: emptyPane(),
                  };
                  setDeck((current) => ({ tabs: [...current.tabs, tab], active: tab.id }));
                  setFocus('');
                  history.pushState(null, '', `#deck?tab=${encodeURIComponent(tab.id)}`);
                }}
              >
                ＋
              </button>
              <span className="workspace-controls">
                <button
                  type="button"
                  onClick={() => {
                    setTabName(active.name);
                    setModal({ kind: 'rename', tabId: active.id });
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={deck.tabs.length <= 1}
                  onClick={() => setModal({ kind: 'close', tabId: active.id })}
                >
                  Close tab
                </button>
              </span>
            </nav>
            <div ref={canvas} className="canvas">
              <Tree
                node={active.root}
                tasks={tasks}
                focus={focus}
                setFocus={setFocus}
                onOpen={(id, tab) => navigate(`#task/${id}/${tab}`)}
                update={(id, change) => modify((root) => updateNode(root, id, change))}
                split={(id, direction) => {
                  if (panes(active.root).length < 8) {
                    modify((root) => splitNode(root, id, direction));
                    setFocus('');
                  }
                }}
                remove={(id) => {
                  modify((root) => removeNode(root, id));
                  setFocus('');
                }}
              />
            </div>
            <p className="note">
              Drafts and local profiles are available. Agent execution and interactive terminals are
              still being ported.
            </p>
          </>
        ) : route.kind === 'tasks' ? (
          <TasksPage
            tasks={tasks}
            onOpen={(id) => navigate(`#task/${id}/overview`)}
            onCreate={() => setDraftOpen(true)}
          />
        ) : route.kind === 'repositories' ? (
          bootstrap ? (
            <RepositoriesPage
              config={bootstrap.config}
              onAdd={() => editRepository()}
              onEdit={editRepository}
            />
          ) : (
            <p role="status">{error || 'Loading repository profiles…'}</p>
          )
        ) : route.kind === 'storage' ? (
          bootstrap ? (
            <StoragePage
              token={bootstrap.token}
              report={storage.report}
              loadError={storage.error}
              refresh={storage.refresh}
            />
          ) : (
            <p role="status">{error || 'Loading storage…'}</p>
          )
        ) : (
          <TaskPage
            key={route.id}
            id={route.id}
            tab={route.tab}
            onTab={(tab) => navigate(`#task/${route.id}/${tab}`)}
            onBack={() => navigate('#tasks')}
            onDeck={() => navigate(`#deck?tab=${encodeURIComponent(deck.active)}`)}
          />
        )}
        {route.kind !== 'deck' && error && (
          <p className="error" role="status">
            {error}
          </p>
        )}
      </main>
      {draftOpen && bootstrap && (
        <DraftComposer
          config={bootstrap.config}
          onCreate={create}
          onClose={() => setDraftOpen(false)}
          onCreated={(task) => {
            setDraftOpen(false);
            navigate(`#task/${task.id}/overview`);
          }}
        />
      )}
      {repoEditor && (
        <RepositoryEditor
          config={repoEditor.config}
          revision={repoEditor.revision}
          profile={repoEditor.profile}
          onSave={updateConfig}
          onClose={() => setRepoEditor(null)}
        />
      )}
      <dialog
        ref={dialog}
        className="workspace-dialog"
        onCancel={(event) => {
          event.preventDefault();
          setModal(null);
        }}
        onClose={() => setModal(null)}
      >
        {modal?.kind === 'rename' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const name = tabName.trim();
              if (!name) return;
              setDeck((current) => ({
                ...current,
                tabs: current.tabs.map((tab) => (tab.id === modal.tabId ? { ...tab, name } : tab)),
              }));
              setModal(null);
            }}
          >
            <h2>Rename workspace</h2>
            <label htmlFor="workspace-name">Workspace name</label>
            <input
              id="workspace-name"
              value={tabName}
              onChange={(event) => setTabName(event.target.value)}
              maxLength={60}
              required
              autoFocus
            />
            <div>
              <button type="button" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button type="submit">Save name</button>
            </div>
          </form>
        ) : modal?.kind === 'close' ? (
          <div>
            <h2>Close workspace?</h2>
            <p>Its layout will be removed. Tasks and agents keep running.</p>
            <div>
              <button type="button" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const remaining = deck.tabs.filter((tab) => tab.id !== modal.tabId);
                  if (!remaining.length) return;
                  setDeck({ tabs: remaining, active: remaining[0]!.id });
                  setFocus('');
                  history.pushState(null, '', `#deck?tab=${encodeURIComponent(remaining[0]!.id)}`);
                  setModal(null);
                }}
              >
                Close workspace
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
