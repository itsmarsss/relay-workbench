import { useTaskNotifications } from './Notifications';
import { useEffect, useRef, useState } from 'react';
import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import { SessionProvider } from './Session';
import { RelayPage } from './Chat';
import { Icon, RelayMark } from './UI';
import { SettingsPage, MemoryPage, InboxPage } from './WorkspacePages';
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

function preference(key: string) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
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
  const prefersReducedMotion = useReducedMotion();
  const {
      tasks,
      bootstrap,
      connected,
      error,
      create,
      updateConfig,
      act,
      approve,
      accept,
      resolve,
      importTicket,
      refresh,
    } = useRelay(),
    [deck, setDeck] = useState(initialDeck),
    [collapsed, setCollapsed] = useState(() => preference('relay-sidebar-collapsed') === 'true'),
    [sidebarWidth, setSidebarWidth] = useState(() =>
      Math.max(208, Math.min(340, Number(preference('relay-sidebar-width')) || 232)),
    ),
    [resizingSidebar, setResizingSidebar] = useState(false),
    [dark, setDark] = useState(() => preference('relay-theme') === 'dark'),
    [lowMotion, setLowMotion] = useState(() => preference('relay-low-motion') === 'true'),
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
  const motionDisabled = lowMotion || prefersReducedMotion;
  useTaskNotifications(tasks, !!bootstrap);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('relay-theme', dark ? 'dark' : 'light');
    } catch {}
  }, [dark]);
  useEffect(() => {
    document.documentElement.dataset.lowMotion = String(lowMotion);
    try {
      localStorage.setItem('relay-low-motion', String(lowMotion));
    } catch {}
  }, [lowMotion]);
  useEffect(() => {
    try {
      localStorage.setItem('relay-sidebar-collapsed', String(collapsed));
      localStorage.setItem('relay-sidebar-width', String(sidebarWidth));
    } catch {}
  }, [collapsed, sidebarWidth]);
  const storage = useStorage();
  const sidebarDrag = useRef<{ x: number; width: number } | null>(null);
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
    <SessionProvider value={{ bootstrap, refresh }}>
      <MotionConfig
        reducedMotion={lowMotion ? 'always' : 'user'}
        transition={{ duration: motionDisabled ? 0 : 0.18 }}
      >
        <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
          <motion.aside
            animate={{ width: collapsed ? 64 : sidebarWidth }}
            transition={{ duration: resizingSidebar || motionDisabled ? 0 : 0.22 }}
            className="sidebar"
            aria-label="Workspace sidebar"
          >
            <div className="brand">
              <button
                className="brand-home"
                aria-label="Relay home"
                onClick={() => navigate('#deck')}
              >
                <RelayMark />
                {!collapsed && <span>relay</span>}
              </button>
              <button
                className="icon-button sidebar-toggle"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed(!collapsed)}
              >
                <Icon name="sidebar" />
              </button>
            </div>
            <div className="sidebar-section-label">Workspace</div>
            <nav className="app-nav" aria-label="Workspace">
              {[
                ['deck', 'Task deck', 'grid'],
                ['relay', 'Relay agent', 'relay'],
                ['tasks', 'All tasks', 'tasks'],
                ['inbox', 'Approval inbox', 'inbox'],
                ['repositories', 'Repositories', 'repository'],
                ['storage', 'Storage', 'storage'],
                ['memory', 'Memory', 'memory'],
              ].map(([kind, label, icon]) => (
                <button
                  aria-label={label}
                  title={label}
                  aria-current={
                    route.kind === kind || (kind === 'tasks' && route.kind === 'task')
                      ? 'page'
                      : undefined
                  }
                  key={kind}
                  onClick={() =>
                    navigate(
                      kind === 'deck' ? `#deck?tab=${encodeURIComponent(deck.active)}` : '#' + kind,
                    )
                  }
                >
                  <Icon name={icon!} />
                  {!collapsed && (
                    <>
                      {label}
                      {kind === 'tasks' && <span className="nav-count">{tasks.length}</span>}
                    </>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <button
                className="sidebar-settings"
                aria-label="Settings"
                title="Settings"
                aria-current={route.kind === 'settings' ? 'page' : undefined}
                onClick={() => navigate('#settings')}
              >
                <Icon name="settings" />
                {!collapsed && 'Settings'}
              </button>
              <div className="sidebar-preferences">
                <button
                  className="icon-button"
                  aria-label={dark ? 'Use light theme' : 'Use dark theme'}
                  onClick={() => setDark(!dark)}
                >
                  <Icon name={dark ? 'sun' : 'moon'} />
                </button>
                {!collapsed && (
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={lowMotion}
                      onChange={(e) => setLowMotion(e.target.checked)}
                    />
                    Low motion
                  </label>
                )}
              </div>
              {storage.report &&
                ['warning', 'critical'].includes(storage.report.pressure.state) && (
                  <button className="storage-alert" onClick={() => navigate('#storage')}>
                    Low disk space
                  </button>
                )}
              <div
                className="connection"
                title={connected ? 'Connected locally · Rewrite preview' : 'Reconnecting'}
              >
                <span className={`connection-dot ${connected ? '' : 'offline'}`} />
                {!collapsed && (
                  <>
                    <span>{connected ? 'Connected locally' : 'Reconnecting'}</span>
                    <small>Preview</small>
                  </>
                )}
              </div>
            </div>
            {!collapsed && (
              <div
                className="sidebar-resize"
                role="separator"
                tabIndex={0}
                aria-label="Resize sidebar"
                aria-orientation="vertical"
                aria-valuemin={208}
                aria-valuemax={340}
                aria-valuenow={sidebarWidth}
                onDoubleClick={() => setSidebarWidth(232)}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  setSidebarWidth((width) =>
                    e.key === 'Home'
                      ? 208
                      : e.key === 'End'
                        ? 340
                        : Math.max(208, Math.min(340, width + (e.key === 'ArrowLeft' ? -16 : 16))),
                  );
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  sidebarDrag.current = { x: e.clientX, width: sidebarWidth };
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setResizingSidebar(true);
                }}
                onPointerMove={(e) => {
                  const start = sidebarDrag.current;
                  if (start)
                    setSidebarWidth(
                      Math.max(208, Math.min(340, start.width + e.clientX - start.x)),
                    );
                }}
                onLostPointerCapture={() => {
                  sidebarDrag.current = null;
                  setResizingSidebar(false);
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
              />
            )}
          </motion.aside>
          <div className="main-shell">
            <header className="app-topbar">
              <nav className="breadcrumb" aria-label="Breadcrumb">
                <span>Workspace</span>
                <Icon name="chevron" size={13} />
                <span>
                  {
                    {
                      deck: 'Task deck',
                      tasks: 'Tasks',
                      task: 'Task workspace',
                      relay: 'Relay agent',
                      inbox: 'Approval inbox',
                      repositories: 'Repositories',
                      storage: 'Storage',
                      memory: 'Memory',
                      settings: 'Settings',
                    }[route.kind]
                  }
                </span>
              </nav>
              <div className="topbar-actions">
                <button
                  className="relay-shortcut"
                  aria-label="Open Relay agent"
                  onClick={() => navigate('#relay')}
                >
                  <Icon name="relay" size={17} />
                  <span>Relay</span>
                </button>
                <button
                  className="primary"
                  aria-label="New task"
                  disabled={!bootstrap}
                  onClick={() => setDraftOpen(true)}
                >
                  <Icon name="plus" size={16} />
                  <span>New task</span>
                </button>
              </div>
            </header>
            <motion.main
              layout={!resizingSidebar}
              className={route.kind === 'deck' ? 'deck-main' : 'page-main'}
            >
              {storage.report &&
                ['warning', 'critical'].includes(storage.report.pressure.state) && (
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
                      <span className="preview">Isolated preview</span>
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
                </>
              ) : route.kind === 'tasks' ? (
                <TasksPage
                  tasks={tasks}
                  onOpen={(id) => navigate(`#task/${id}/overview`)}
                  onCreate={() => setDraftOpen(true)}
                />
              ) : route.kind === 'inbox' ? (
                <InboxPage onOpen={(id) => navigate(`#task/${id}/overview`)} />
              ) : route.kind === 'memory' ? (
                <MemoryPage />
              ) : route.kind === 'settings' ? (
                bootstrap ? (
                  <SettingsPage onSave={updateConfig} />
                ) : (
                  <p>Loading settings…</p>
                )
              ) : route.kind === 'relay' ? (
                <RelayPage />
              ) : route.kind === 'repositories' ? (
                bootstrap ? (
                  <RepositoriesPage
                    config={bootstrap.config}
                    onAdd={editRepository}
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
                  workflowPreview={bootstrap?.workflowPreview === true}
                  implementationPreview={bootstrap?.implementationPreview === true}
                  debugRecoveryPreview={bootstrap?.debugRecoveryPreview === true}
                  onAction={act}
                  onApprove={approve}
                  onAccept={accept}
                  onResolve={resolve}
                  onTab={(tab) => {
                    const q = location.hash.split('?')[1];
                    navigate(`#task/${route.id}/${tab}${q ? '?' + q : ''}`);
                  }}
                  onBack={() => navigate('#tasks')}
                  onDeck={() => navigate(`#deck?tab=${encodeURIComponent(deck.active)}`)}
                />
              )}
              {route.kind !== 'deck' && error && (
                <p className="error" role="status">
                  {error}
                </p>
              )}
            </motion.main>
          </div>
          {draftOpen && bootstrap && (
            <DraftComposer
              config={bootstrap.config}
              workflowPreview={bootstrap.workflowPreview}
              issueImportPreview={bootstrap.issueImportPreview}
              onImport={importTicket}
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
                    tabs: current.tabs.map((tab) =>
                      tab.id === modal.tabId ? { ...tab, name } : tab,
                    ),
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
                      history.pushState(
                        null,
                        '',
                        `#deck?tab=${encodeURIComponent(remaining[0]!.id)}`,
                      );
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
      </MotionConfig>
    </SessionProvider>
  );
}
