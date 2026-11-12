import { useTaskNotifications } from './Notifications';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import { SessionProvider } from './Session';
import { RelayPage, ChatPanel } from './Chat';
import { Appearance, type Theme } from './Appearance';
import { OverviewPage } from './OverviewPage';
import { Icon, RelayMark } from './UI';
import { Modal } from './Modal';
import { SettingsPage, MemoryPage, InboxPage } from './WorkspacePages';
import { emptyPane, newDeck, parseDeck, type Deck } from './deck';
import { type RelayConfig, type RepositoryProfile } from './types';
import { TaskDeck } from './TaskDeck';
import { useRelay } from './useRelay';
import { DraftComposer } from './DraftComposer';
import { RepositoryEditor } from './RepositoryEditor';
import { RepositoriesPage } from './RepositoriesPage';
import { TasksPage } from './TasksPage';
import { TaskPage } from './TaskPage';
import { StoragePage } from './StoragePage';
import { useStorage } from './useStorage';
import { parseRoute } from './route';

const usePageLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const workspaceNavigation = [
  ['overview', 'Overview', 'grid'],
  ['relay', 'Relay agent', 'relay'],
  ['tasks', 'All tasks', 'tasks'],
  ['deck', 'Task deck', 'grid'],
  ['inbox', 'Approval inbox', 'inbox'],
  ['repositories', 'Repositories', 'repository'],
  ['agents', 'Agents', 'bolt'],
  ['memory', 'Memory', 'memory'],
] as const;

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
    [mobileNavOpen, setMobileNavOpen] = useState(false),
    [theme, setTheme] = useState<Theme>(
      () =>
        (['light', 'dark'].includes(preference('relay-theme'))
          ? preference('relay-theme')
          : 'system') as Theme,
    ),
    [systemDark, setSystemDark] = useState(
      () =>
        typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
    ),
    [relayOpen, setRelayOpen] = useState(false),
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
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open]:not(.orchestrator-dialog)')) return;
        event.preventDefault();
        setRelayOpen((current) => !current);
      } else if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'n' &&
        bootstrap &&
        !document.querySelector('dialog[open]') &&
        !(event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')
      ) {
        event.preventDefault();
        setDraftOpen(true);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [bootstrap]);
  useTaskNotifications(tasks, !!bootstrap);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('relay-theme', theme);
    } catch {}
  }, [dark, theme]);
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
  const main = useRef<HTMLElement>(null);
  const pageKey = route.kind === 'task' ? `${route.kind}/${route.id}/${route.tab}` : route.kind;
  usePageLayoutEffect(() => {
    main.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pageKey]);
  const sidebarDrag = useRef<{ x: number; width: number } | null>(null);
  const active = deck.tabs.find((tab) => tab.id === deck.active) || deck.tabs[0]!;
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(deck));
    } catch {}
  }, [deck]);
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

  return (
    <SessionProvider value={{ bootstrap, refresh }}>
      <Appearance.Provider value={{ theme, setTheme, lowMotion, setLowMotion }}>
        <MotionConfig
          skipAnimations={!!motionDisabled}
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
                  onClick={() => navigate('#overview')}
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
              <button
                className="mobile-nav-toggle"
                onClick={() => setMobileNavOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={mobileNavOpen}
              >
                <Icon name="menu" size={18} />
                Menu
              </button>
              <nav className="app-nav" aria-label="Workspace">
                {workspaceNavigation.map(([kind, label, icon]) => (
                  <button
                    aria-label={kind === 'tasks' && !collapsed ? `${label} ${tasks.length}` : label}
                    title={label}
                    aria-current={
                      route.kind === kind || (kind === 'tasks' && route.kind === 'task')
                        ? 'page'
                        : undefined
                    }
                    key={kind}
                    onClick={() =>
                      navigate(
                        kind === 'deck'
                          ? `#deck?tab=${encodeURIComponent(deck.active)}`
                          : '#' + kind,
                      )
                    }
                  >
                    {(route.kind === kind || (kind === 'tasks' && route.kind === 'task')) && (
                      <motion.i className="nav-pill" layoutId="nav-pill" aria-hidden="true" />
                    )}
                    <Icon name={icon!} />
                    {!collapsed && (
                      <>
                        {label}{' '}
                        {kind === 'tasks' && (
                          <span className="nav-count" aria-hidden="true">
                            {tasks.length}
                          </span>
                        )}
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
                {storage.report &&
                  ['warning', 'critical'].includes(storage.report.pressure.state) && (
                    <button
                      className="storage-alert"
                      aria-label="Low disk space"
                      title="Low disk space"
                      onClick={() => navigate('#storage')}
                    >
                      <Icon name="alert" size={16} />
                      {!collapsed && 'Low disk space'}
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
                      <small>v0.1 · Go</small>
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
                          : Math.max(
                              208,
                              Math.min(340, width + (e.key === 'ArrowLeft' ? -16 : 16)),
                            ),
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
                        overview: 'Overview',
                        agents: 'Agents',
                      }[route.kind]
                    }
                  </span>
                </nav>
                <div className="topbar-actions">
                  <span className="shortcut-action">
                    <button
                      className="relay-shortcut"
                      aria-label="Open Relay agent"
                      aria-keyshortcuts="Meta+k Control+k"
                      onClick={() => setRelayOpen(true)}
                    >
                      <Icon name="relay" size={17} />
                      <span>Relay</span>
                    </button>
                    <kbd className="keyboard-hint" aria-hidden="true">
                      {typeof navigator !== 'undefined' &&
                      /Mac|iPhone|iPad/.test(navigator.platform)
                        ? '⌘K'
                        : 'Ctrl K'}
                    </kbd>
                  </span>
                  <span className="shortcut-action shortcut-primary">
                    <button
                      className="primary"
                      aria-label="New task"
                      aria-keyshortcuts="n"
                      disabled={!bootstrap}
                      onClick={() => setDraftOpen(true)}
                    >
                      <Icon name="plus" size={16} />
                      <span>New task</span>
                    </button>
                    <kbd className="keyboard-hint" aria-hidden="true">
                      N
                    </kbd>
                  </span>
                </div>
              </header>
              <motion.main
                ref={main}
                layoutScroll
                layout={!resizingSidebar}
                className={route.kind === 'deck' ? 'deck-main' : 'page-main'}
              >
                {storage.report &&
                  ['warning', 'critical'].includes(storage.report.pressure.state) && (
                    <button className="mobile-storage-alert" onClick={() => navigate('#storage')}>
                      Low disk space · Review storage
                    </button>
                  )}
                {route.kind === 'overview' ? (
                  <OverviewPage
                    tasks={tasks}
                    loading={!bootstrap}
                    onNavigate={navigate}
                    onCreate={() => setDraftOpen(true)}
                  />
                ) : route.kind === 'deck' ? (
                  <TaskDeck
                    active={active}
                    tabs={deck.tabs}
                    tasks={tasks}
                    error={error}
                    loading={!bootstrap}
                    focus={focus}
                    setFocus={setFocus}
                    onSelect={selectTab}
                    onAdd={() => {
                      const tab = {
                        id: crypto.randomUUID(),
                        name: `Workspace ${deck.tabs.length + 1}`,
                        root: emptyPane(),
                        layout: 'grid' as const,
                        columns: 3 as const,
                        density: 'auto' as const,
                        mode: 'pinned' as const,
                      };
                      setDeck((current) => ({ tabs: [...current.tabs, tab], active: tab.id }));
                      setFocus('');
                      history.pushState(null, '', `#deck?tab=${encodeURIComponent(tab.id)}`);
                    }}
                    onRename={() => {
                      setTabName(active.name);
                      setModal({ kind: 'rename', tabId: active.id });
                    }}
                    onClose={() => setModal({ kind: 'close', tabId: active.id })}
                    onUpdate={(patch) =>
                      setDeck((current) => ({
                        ...current,
                        tabs: current.tabs.map((tab) =>
                          tab.id === current.active ? { ...tab, ...patch } : tab,
                        ),
                      }))
                    }
                    onOpen={(id, tab) => navigate(`#task/${id}/${tab}`)}
                    onCreate={() => setDraftOpen(true)}
                  />
                ) : route.kind === 'tasks' ? (
                  <TasksPage
                    tasks={tasks}
                    loading={!bootstrap}
                    onOpen={(id) => navigate(`#task/${id}/overview`)}
                    onCreate={() => setDraftOpen(true)}
                  />
                ) : route.kind === 'inbox' ? (
                  <InboxPage
                    tasks={tasks}
                    loading={!bootstrap}
                    onOpen={(id) => navigate(`#task/${id}/overview`)}
                  />
                ) : route.kind === 'memory' ? (
                  <MemoryPage />
                ) : route.kind === 'settings' || route.kind === 'agents' ? (
                  bootstrap ? (
                    <SettingsPage key={route.kind} mode={route.kind} onSave={updateConfig} />
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
                      tasks={tasks}
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
            {/* The task page's conversation renders here, as a column beside the page. */}
            <div id="ask-dock" className="ask-dock-slot" />
            {relayOpen && (
              <Modal
                title="Relay orchestrator"
                variant="drawer"
                className="orchestrator-dialog"
                onClose={() => setRelayOpen(false)}
              >
                <ChatPanel compact persistSelection={false} />
              </Modal>
            )}
            {mobileNavOpen && (
              <Modal title="Workspace" onClose={() => setMobileNavOpen(false)}>
                <nav className="mobile-workspace-menu" aria-label="Mobile workspace">
                  {[...workspaceNavigation, ['settings', 'Settings', 'settings']].map(
                    ([kind, label, icon]) => (
                      <button
                        type="button"
                        key={kind}
                        aria-current={
                          route.kind === kind || (kind === 'tasks' && route.kind === 'task')
                            ? 'page'
                            : undefined
                        }
                        onClick={() => {
                          setMobileNavOpen(false);
                          navigate(
                            kind === 'deck'
                              ? `#deck?tab=${encodeURIComponent(deck.active)}`
                              : '#' + kind,
                          );
                        }}
                      >
                        <Icon name={icon!} />
                        {label}
                      </button>
                    ),
                  )}
                </nav>
              </Modal>
            )}
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
            {modal && (
              <Modal
                title={modal.kind === 'rename' ? 'Rename workspace' : 'Close workspace?'}
                onClose={() => setModal(null)}
                onSubmit={
                  modal.kind === 'rename'
                    ? (event) => {
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
                      }
                    : undefined
                }
                footer={
                  <>
                    <button type="button" onClick={() => setModal(null)}>
                      Cancel
                    </button>
                    {modal.kind === 'rename' ? (
                      <button className="primary" type="submit">
                        Save name
                      </button>
                    ) : (
                      <button
                        className="danger"
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
                    )}
                  </>
                }
              >
                {modal.kind === 'rename' ? (
                  <label className="field" htmlFor="workspace-name">
                    Workspace name
                    <input
                      id="workspace-name"
                      value={tabName}
                      onChange={(event) => setTabName(event.target.value)}
                      maxLength={60}
                      required
                      autoFocus
                    />
                  </label>
                ) : (
                  <p>Its layout will be removed. Tasks and agents keep running.</p>
                )}
              </Modal>
            )}
          </div>
        </MotionConfig>
      </Appearance.Provider>
    </SessionProvider>
  );
}
