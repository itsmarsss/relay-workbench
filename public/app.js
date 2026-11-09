import { completedPlan } from './workflow-plan.js';
import {
  automationControl,
  checkpointControl,
  workflowControlAction,
} from './workflow-controls.js';
import { syncGraphDialog } from './graph-dialog.js';
import { syncTaskDescriptions } from './task-description.js';
import {
  installTaskMentions,
  composedQuestion,
  syncTaskComposer,
  submittedMentions,
  clearComposerMentions,
} from './task-mention-picker.js';
import { healthPanel, completionPanel, coordinationPanel } from './productivity.js';
import { syncTabMotion } from './tab-motion.js';
import { installTaskContextMenu } from './task-context-menu.js';
import { confirmation } from './confirmation.js';
import { workspaceAgentView } from './workspace-agent.js';
import { installRepositorySuggestions } from './repository-suggestions.js';
import { notify, syncToastLayer } from './notifications.js';
import { installBoardDrag } from './board-drag.js';
import { boardStatuses, columns, workflowColumn, nextStep } from './workflow.js';
import { sidebarControls, syncSidebar } from './sidebar.js';
import { repositoryProfileForm, syncRepositoryProfile } from './repository-profile.js';
import { modelPicker, modelCatalogHint } from './model-picker.js';
import { repositoryDiscoveryPanel } from './repository-discovery.js';
import { workspaceCard } from './workspace-card.js';
import { followUpComposer } from './follow-up.js';
import {
  lowMotion,
  setLowMotion,
  animateEntrances,
  animateSurface,
  animateExit,
} from './motion-preferences.js';
import './chat-window.js';
import { readTaskFilters, writeTaskFilters } from './task-filters-route.js';
import { planOptions } from './plan-options.js';
import { refreshQueue, latestLoader, eventBatch } from './async-state.js';
import { statusQueue } from './pending-status.js';
const pendingStatuses = statusQueue(localStorage);
import { displayStatus, overrideStatuses } from './task-status.js';
import { taskRuns } from './task-runs.js';
import {
  publicationPanel,
  deliveryWorkflowStages,
  feedbackWorkflowStage,
  publicationDetails,
} from './publication.js';
import { memoryPage, memoryForm, runMemories, memoryRunHistory } from './memory.js';
import { prepareSearchSelects } from './search-select.js';
import { updateLiveDOM } from './live-dom.js';
import { handoffBody, handoffList, workflowStages, executionLogs } from './task-panels.js';
import {
  activityRunSelection,
  activityRunNavigation,
  activityRunHeader,
  activityEventIdentity,
  activityEventMeta,
  activityPassoff,
} from './activity-runs.js';
import { taskRoute, parseTaskRoute } from './task-route.js';
import { executionMap, graphLayout, focusGraphNode } from './execution-map.js';
import { liveProgress, timer, updateTimers } from './live-progress.js';
import { sideChat } from './side-chat.js';
import { blockerDecisionView } from './blocker-decision.js';
import { taskSummary, concise } from './task-summary.js';
import { storageView, bytes } from './storage.js';
import { outcomesView } from './outcomes.js';
import { diffLines, diffFileGroups } from './diff-lines.js';
import { inboxPage, notifyInbox, notifyResults } from './inbox.js';
import { installImageUploads, openImageViewer } from './image-uploads.js';
import { tasksPage } from './tasks.js';
import { taskForm, syncTaskForm, readTaskForm } from './task-editor.js';
import { markdownEditor, handleMarkdownAction } from './markdown.js';
import { issueLink, taskDetails } from './task-details.js';
import { terminalView, terminalSelection } from './terminals.js';
import { syncBrowserTerminal } from './browser-terminal.js';
import {
  e,
  tabIndicator,
  icon,
  stageNames,
  statusNames,
  badge,
  harnessBadge,
  duration,
  ago,
  prose,
  empty,
} from './ui.js';

const state = {
  workspaceChatId: readWorkspaceChatId(),
  workspaceChatListOpen: false,
  workspaceChatSearch: '',
  orchestratorDraft: readWorkspaceDraft(readWorkspaceChatId()),
  modelCatalog: {},
  modelCatalogLoading: false,
  repositoryDiscovery: null,
  memories: [],
  memoryAvailable: false,
  memoryQuery: '',
  memoryFilter: 'all',
  logRun: 'latest',
  logStream: 'all',
  logQuery: '',
  activitySelection: 'latest',
  activityTaskId: null,
  sideChatOpen: false,
  executionMapOpen: false,
  graphSelectedId: null,
  graphZoom: 1,
  storage: null,
  outcomes: null,
  outcomesRepository: '',
  inbox: [],
  config: null,
  tasks: [],
  harnesses: [],
  view: 'overview',
  selected: null,
  task: null,
  events: [],
  tab: 'overview',
  filter: 'all',
  taskLayout: localStorage.getItem('relay-task-layout') === 'board' ? 'board' : 'list',
  repositoryFilter: '',
  stageFilter: '',
  taskSort: 'priority',
  showEmptyStages: false,
  search: '',
  token: '',
  connected: true,
  diff: null,
  modal: null,
  busy: false,
  terminalId: '',
  terminalPreview: null,
  terminalFollow: true,
};
const app = document.querySelector('#app');
let refreshTimer, stream, modalReturnFocus;
async function api(path, method = 'GET', data, { timeoutMs = 10000 } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    signal: method === 'GET' ? AbortSignal.timeout(timeoutMs) : undefined,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Token': state.token },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}
async function loadMemories() {
  try {
    const memories = await api('/memories');
    state.memoryAvailable = true;
    return memories;
  } catch (error) {
    if (error.status !== 404) throw error;
    state.memoryAvailable = false;
    return [];
  }
}
const toast = notify;

function button(action, label, kind = '', iconName = '', attrs = '') {
  return `<button class="btn ${kind}" data-action="${action}" ${attrs}>${iconName ? icon(iconName) : ''}${label}</button>`;
}
function nav(view, label, name, extra = '') {
  return `<button class="nav-item ${state.view === view ? 'active' : ''}" ${state.view === view ? 'aria-current="page"' : ''} data-action="navigate" data-view="${view}" aria-label="${e(label)}" title="${e(label)}">${icon(name)}<span>${label}</span>${extra}</button>`;
}
function shell() {
  app.innerHTML = `<aside class="sidebar" aria-label="Workspace sidebar"><div class="sidebar-heading"><a class="brand" href="#" data-action="navigate" data-view="overview" aria-label="Relay overview"><span class="brand-mark">${icon('relay')}</span><span class="brand-name">relay</span></a>${sidebarControls()}</div><div class="sidebar-section-label">Workspace</div><nav id="workspace-navigation" aria-label="Workspace">${nav('overview', 'Overview', 'grid')}${nav('assistant', 'Relay agent', 'relay')}${nav('tasks', 'All tasks', 'layers', `<span class="nav-count">${state.tasks.length}</span>`)}${nav('inbox', 'Approval inbox', 'eye')}${nav('repositories', 'Repositories', 'folder')}${nav('harnesses', 'Agents', 'bolt')}${nav('memory', 'Memory', 'book')}</nav><div class="sidebar-bottom">${nav('settings', 'Settings', 'settings')}<div class="connection"><span class="local-dot ${state.connected ? '' : 'offline'}"></span><span>${state.connected ? 'Connected locally' : 'Reconnecting…'}</span><small>v0.1</small></div></div></aside><div class="main-shell"><header class="topbar"><div class="breadcrumb"><span class="breadcrumb-root">Workspace</span> ${icon('chevron')} <span>${state.view === 'task' ? 'Task workspace' : ({ assistant: 'Relay agent', harnesses: 'Agents', inbox: 'Approval inbox' }[state.view] ?? state.view.charAt(0).toUpperCase() + state.view.slice(1))}</span></div><div class="top-actions"><button class="btn small orchestrator-trigger" data-action="open-orchestrator" aria-label="Open Relay orchestrator" aria-haspopup="dialog" aria-controls="relay-orchestrator" aria-expanded="false" title="Open Relay · Command/Ctrl K">${icon('relay')}<span>Relay</span><kbd class="keyboard-hint">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd></button><button class="btn primary small new-task-button" data-action="new-task" aria-label="New task">${icon('plus')}<span>New task</span><kbd class="keyboard-hint" title="Keyboard shortcut: N">N</kbd></button></div></header><main id="main"></main></div>`;
  syncSidebar();
  renderMain();
}
function renderMain() {
  const main = document.querySelector('#main');
  if (
    !main ||
    document.documentElement.hasAttribute('data-chat-interacting') ||
    main.querySelector('[data-uploading]') ||
    (state.view === 'tasks' && (state.boardDragging || state.boardMoving))
  )
    return;
  const editorModes = [...main.querySelectorAll('[data-editor]')].map((el) => ({
    id: el.dataset.editor,
    preview: el.querySelector('[data-mode="preview"]')?.getAttribute('aria-selected') === 'true',
  }));
  const panelScroll = [
    '.node-graph-scroll',
    '.graph-inspector',
    '.side-chat-history',
    '.workspace-messages',
    '.activity-run-content .timeline',
    '.activity-run-list',
  ].map((selector) => {
    const node = main.querySelector(selector);
    return { selector, top: node?.scrollTop, left: node?.scrollLeft };
  });
  const sideHistory = main.querySelector('.side-chat-history');
  const followSide =
    !sideHistory ||
    sideHistory.scrollHeight - sideHistory.clientHeight - sideHistory.scrollTop < 48;
  const workspaceHistory = main.querySelector('.workspace-messages');
  const followWorkspace =
    !workspaceHistory ||
    workspaceHistory.scrollHeight - workspaceHistory.clientHeight - workspaceHistory.scrollTop < 48;
  const scroll = main.scrollTop;
  const terminalScroll = main.querySelector('.terminal-preview')?.scrollTop;
  const descriptionScroll = main.querySelector('.task-description')?.scrollTop;
  const boardScroll = main.querySelector('.workflow-board')?.scrollLeft;
  const focused = document.activeElement;
  const focusId = main.contains(focused) ? focused.id : null;
  const terminalFocused = !!focused?.closest('[data-browser-terminal]');
  const inputs = [...main.querySelectorAll('textarea,input')]
    .filter((i) => i.id && !['task-search', 'memory-search'].includes(i.id) && i.type !== 'file')
    .map((i) => ({
      id: i.id,
      value: i.value,
      start: i.selectionStart,
      end: i.selectionEnd,
      checked: i.checked,
    }));
  const modelDrafts = [...main.querySelectorAll('select[data-model-provider]')].map((select) => ({
    id: select.id,
    provider: select.dataset.modelProvider,
    value: select.value,
    label: select.selectedOptions[0]?.textContent,
  }));
  const expanded = new Map(
    [...main.querySelectorAll('details[data-event-key]')].map((d) => [d.dataset.eventKey, d.open]),
  );
  const selectedApproach = main.querySelector('input[name="optionId"]:checked')?.value;
  const markup =
    state.view === 'assistant'
      ? workspaceAgentView(state.workspaceMessages, state.tasks, {
          info: {
            ...state.workspaceInfo,
            chatListOpen: state.workspaceChatListOpen,
            chatSearch: state.workspaceChatSearch,
          },
        })
      : state.view === 'memory'
        ? state.memoryAvailable
          ? memoryPage(state.memories, state.config, state.tasks, {
              query: state.memoryQuery,
              filter: state.memoryFilter,
            })
          : '<section class="settings-panel"><h1>Memory</h1><p>The memory backend update is waiting for active work to finish. Your pipeline keeps running. Reload after Relay restarts to use memory.</p></section>'
        : state.view === 'inbox'
          ? inboxPage(state.inbox)
          : state.view === 'overview'
            ? overview()
            : state.view === 'tasks'
              ? tasksView()
              : state.view === 'task'
                ? taskView()
                : state.view === 'repositories'
                  ? repositoriesView()
                  : state.view === 'harnesses'
                    ? harnessesView()
                    : settingsView();
  if (state.view === 'tasks') writeTaskFilters(state);
  main.dataset.motionScope = `${state.view}:${state.selected ?? ''}:${state.tab}`;
  updateLiveDOM(main, markup, `${state.view}:${state.selected ?? ''}`);
  const composer = main.querySelector('#workspace-request');
  if (composer) {
    composer.value = state.orchestratorDraft ?? '';
    syncTaskComposer(composer);
  }
  for (const draft of modelDrafts) {
    const select = document.getElementById(draft.id);
    if (!select || select.dataset.modelProvider !== draft.provider) continue;
    if (![...select.options].some((option) => option.value === draft.value))
      select.add(new Option(draft.label || draft.value, draft.value));
    select.value = draft.value;
    select.closest('relay-select')?.sync();
  }
  animateEntrances(main);
  syncTabMotion(main);
  syncBrowserTerminal(state.task, state.token, terminalFocused);
  for (const i of inputs) {
    const element = document.getElementById(i.id);
    if (element?.type === 'checkbox') element.checked = i.checked;
    if (element && !['checkbox', 'radio'].includes(element.type)) {
      element.value = i.value;
      if (i.id === focusId) {
        element.focus({ preventScroll: true });
        if (element.setSelectionRange && element.type !== 'number')
          element.setSelectionRange(i.start, i.end);
      }
    }
  }
  for (const d of main.querySelectorAll('details[data-event-key]'))
    if (expanded.has(d.dataset.eventKey)) d.open = expanded.get(d.dataset.eventKey);
  if (selectedApproach)
    for (const input of main.querySelectorAll('input[name="optionId"]'))
      input.checked = input.value === selectedApproach;
  for (const mode of editorModes)
    if (mode.preview) {
      const editor = [...main.querySelectorAll('[data-editor]')].find(
        (el) => el.dataset.editor === mode.id,
      );
      const tab = editor?.querySelector('[data-mode="preview"]');
      if (tab) handleMarkdownAction(tab);
    }
  const preview = main.querySelector('.terminal-preview');
  if (preview)
    preview.scrollTop =
      state.terminalFollow && terminalSelection(state.task, state.terminalId)?.live
        ? preview.scrollHeight
        : (terminalScroll ?? 0);
  const description = main.querySelector('.task-description');
  if (description && descriptionScroll !== undefined) description.scrollTop = descriptionScroll;
  if (focusId && !inputs.some((i) => i.id === focusId))
    document.getElementById(focusId)?.focus({ preventScroll: true });
  for (const saved of panelScroll) {
    const node = main.querySelector(saved.selector);
    if (node && saved.top !== undefined) {
      node.scrollTop = saved.top;
      node.scrollLeft = saved.left;
    }
  }
  const nextHistory = main.querySelector('.side-chat-history');
  if (followSide && nextHistory) nextHistory.scrollTop = nextHistory.scrollHeight;
  const workspaceMessages = main.querySelector('.workspace-messages');
  if (followWorkspace && workspaceMessages)
    workspaceMessages.scrollTop = workspaceMessages.scrollHeight;
  main.scrollTop = scroll;
  syncOrchestrator();
  syncTaskDescriptions(main);
  syncGraphDialog();
  const board = main.querySelector('.workflow-board');
  if (board) {
    if (boardScroll !== undefined) board.scrollLeft = boardScroll;
    else focusBoard();
  }
}
function pageHeading(kicker, title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function counts() {
  return {
    active: state.tasks.filter((t) =>
      ['running', 'queued', 'publishing', 'review'].includes(displayStatus(t)),
    ),
    waiting: state.tasks.filter((t) =>
      ['awaiting_plan', 'awaiting_final', 'blocked', 'interrupted', 'paused', 'manual'].includes(
        displayStatus(t),
      ),
    ),
    complete: state.tasks.filter((t) => displayStatus(t) === 'completed'),
  };
}
function overview() {
  const c = counts();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  return `${pageHeading('YOUR DEVELOPMENT, ORCHESTRATED', `${greeting} Let’s make progress.`, 'Your active work, decisions, and recent results.', button('demo', 'Try a demo', 'secondary', 'spark'))}<div class="stats-grid"><button class="stat-card" data-action="overview-filter" data-filter="active"><span>In progress</span>${icon('bolt')}<strong>${c.active.length}<small>active workflows</small></strong><div class="stat-foot">View active work</div></button><button class="stat-card attention" data-action="overview-filter" data-filter="attention"><span>Needs your input</span>${icon('eye')}<strong>${c.waiting.length}<small>decisions & blockers</small></strong><div class="stat-foot">${c.waiting.length ? 'Review decisions and blockers' : 'Nothing waiting on you'}</div></button><button class="stat-card" data-action="overview-filter" data-filter="completed"><span>Done</span>${icon('check')}<strong>${c.complete.length}<small>accepted results</small></strong><div class="stat-foot">View accepted work</div></button></div>${
    c.waiting.length
      ? `<section class="section"><div class="section-title"><h2>Needs your input <span class="count-chip">${c.waiting.length}</span></h2></div><div class="decision-grid">${c.waiting
          .slice(0, 4)
          .map(
            (t) =>
              `<button class="decision-card" data-action="open-task" data-id="${t.id}"><span class="decision-icon">${icon(t.status === 'awaiting_plan' ? 'git' : 'eye')}</span><span class="decision-copy"><small>${e(statusNames[t.status])}${t.demo ? ' · Demo' : ''}</small><strong>${e(t.title)}</strong><span>${e(t.latestSummary || t.error || 'Your input is needed.')}</span></span>${icon('arrow')}</button>`,
          )
          .join('')}</div></section>`
      : ''
  }<section class="section"><div class="section-title"><h2>Recent work <span class="count-chip">${state.tasks.length}</span></h2>${button('navigate', 'View all tasks', 'text', 'arrow', 'data-view="tasks"')}</div>${state.tasks.length ? taskTable(state.tasks.slice(0, 8)) : `<div class="welcome-card"><div class="welcome-art"><span class="orbit-label left">${harnessBadge('codex')} Codex</span><span class="orbit-center">${icon('relay')}</span><span class="orbit-label right">${harnessBadge('claude')} Claude</span><span class="orbit-label bottom">${harnessBadge('pi')} Pi</span></div><h2>Your next task has a whole team behind it.</h2><p>Investigation, thoughtful design, implementation, and an independent<br> review — connected by one clear thread.</p><div class="welcome-actions">${button('new-task', 'Create your first task', 'primary', 'plus')}${button('demo', 'Explore a demo', 'secondary', 'arrow')}</div><small>You approve the approach. You have the final say.</small></div>`}</section>${!state.tasks.length ? `<div class="how-it-works"><div><span class="eyebrow">A WORKFLOW THAT THINKS AHEAD</span><h3>Hands-free work.<br>Human-led decisions.</h3></div><div class="flow-mini">${['Investigate', 'Design', 'You approve', 'Build & verify', 'Review', 'You accept'].map((s, i) => `${i ? icon('chevron') : ''}<span class="${s.startsWith('You') ? 'human' : ''}">${s}</span>`).join('')}</div></div>` : ''}`;
}
function taskTable(tasks) {
  return `<div class="task-table"><div class="table-header"><span>Task</span><span>Status</span><span>Specialists</span><span>Updated</span><span></span></div>${tasks.map((t) => `<button class="task-row" data-action="open-task" data-id="${t.id}"><span class="task-name"><span class="task-symbol">${icon('layers')}</span><span><strong>${e(t.title)} ${t.demo ? '<em class="demo-label">DEMO</em>' : ''}</strong><small>${e((t.repositories?.length ? t.repositories.map((r) => r.repository.name) : [t.repository.name]).join(' + '))} <span>·</span> ${e(nextStep(t))}</small></span></span><span>${badge(displayStatus(t))}</span><span class="avatar-stack">${[...new Set(Object.values(t.routing).filter((h) => h !== 'checks'))].map((h) => harnessBadge(h)).join('')}</span><span class="muted">${ago(t.updatedAt)}</span>${icon('chevron')}</button>`).join('')}</div>`;
}
async function moveBoardTask(id, lane) {
  const task = state.tasks.find((task) => task.id === id);
  if (
    !task ||
    !Object.hasOwn(boardStatuses, lane) ||
    workflowColumn(task) === lane ||
    state.boardMoving
  )
    return;
  state.boardMoving = true;
  const card = [...document.querySelectorAll('.board-card')].find((node) => node.dataset.id === id);
  card?.setAttribute('aria-busy', 'true');
  try {
    const updated = await api(`/tasks/${id}/status-override`, 'POST', {
      value: boardStatuses[lane],
      lane,
    });
    pendingStatuses.clear(id);
    state.tasks = state.tasks.map((task) => (task.id === id ? updated : task));
    toast(`Moved to ${columns.find(([key]) => key === lane)[1]}. Workflow unchanged.`);
  } catch (error) {
    toast(`Couldn’t move task: ${error.message}`, true);
  } finally {
    state.boardMoving = false;
    renderMain();
  }
}
function chooseBoardMove(id) {
  const task = state.tasks.find((task) => task.id === id);
  if (!task) return;
  state.modal = { boardTaskId: id };
  showModal(
    'Move task',
    `<form id="board-move-form"><p class="modal-description">${e(task.title)}</p><label class="field-label" for="board-move-lane">Board column</label><select class="input" id="board-move-lane" name="lane">${columns.map(([key, label]) => `<option value="${key}" ${workflowColumn(task) === key ? 'selected' : ''}>${label}</option>`).join('')}</select><p class="form-help">Changes the board status only. Agents keep running and approval gates still apply. Choose Automatic in the task’s status editor to follow the workflow again.</p><div class="modal-footer"><button type="button" class="btn text" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">Move task</button></div></form>`,
  );
}
installBoardDrag({
  onDrag: (active) => {
    state.boardDragging = active;
    if (!active) renderMain();
  },
  onMove: moveBoardTask,
  onChoose: chooseBoardMove,
});
function focusBoard(lane) {
  const board = document.querySelector('.workflow-board');
  if (!board) return;
  const column = lane
    ? [...board.querySelectorAll('.board-column')].find((el) => el.dataset.lane === lane)
    : board.querySelector('.board-column:not([data-count="0"])');
  if (column)
    board.scrollLeft += column.getBoundingClientRect().left - board.getBoundingClientRect().left;
}
function tasksView() {
  return tasksPage(state);
}
function taskView() {
  const t = state.task;
  if (!t) return '<div class="boot">Loading task…</div>';
  if (state.panelTaskId !== t.id) {
    state.panelTaskId = t.id;
    state.logRun = 'latest';
    state.logStream = 'all';
    state.logQuery = '';
  }
  const live = ['running', 'queued'].includes(t.status);
  const last = t.attempts.findLast((a) => a.handoff)?.handoff;
  return `<div class="task-heading ${t.status === 'completed' ? 'is-complete' : ''}"><button class="back-link" data-action="navigate" data-view="tasks">← All tasks</button><div class="task-title-row"><h1>${e(t.title)}</h1>${t.demo ? '<span class="demo-label large">SIMULATED DEMO</span>' : ''}</div><div class="task-subtitle"><button class="status-editor" data-action="edit-status" aria-label="Change task status" title="${t.statusOverride ? 'Manual status override' : 'Change task status'}">${badge(displayStatus(t))}${icon('chevron')}</button><span>${e((t.repositories?.length ? t.repositories.map((r) => r.repository.name) : [t.repository.name]).join(' + '))}</span><span>·</span><span>${t.id.slice(0, 8)}</span>${t.ticket ? `<span>·</span>${issueLink(t.ticket)}` : ''}<span>·</span><span>Created ${ago(t.createdAt).toLowerCase()}</span></div>${liveProgress(t, state.events)}<div class="task-controls">${automationControl(t)}${!['completed', 'cancelled'].includes(t.status) ? button('configure-task', ['running', 'queued', 'manual'].includes(t.status) ? 'Pause & configure' : 'Configure task', 'secondary', 'settings') : ''}${button('duplicate-task', 'Duplicate task', 'text small', 'plus')}${button('delete-task', 'Delete task', 'text small danger', 'trash')}${t.status === 'draft' ? button('task-action', 'Start workflow', 'primary', 'bolt', 'data-operation="start"') : ''}${['blocked', 'interrupted', 'paused'].includes(t.status) && !(t.status === 'blocked' && t.blockerDecision) ? button('task-action', 'Resume workflow', 'primary', 'arrow', 'data-operation="resume"') : ''}${t.status === 'manual' ? button('task-action', 'Return to automation', 'primary', 'arrow', 'data-operation="return-control"') : ''}${live ? button('task-action', 'Pause', 'secondary small', 'pause', 'data-operation="pause"') : ''}${!['completed', 'cancelled'].includes(t.status) ? button('confirm-cancel', 'Cancel', 'text small') : ''}<a class="btn text small" href="/api/tasks/${t.id}/export" download>${icon('download')}Export</a></div></div>${t.demo ? '<div class="demo-banner">' + icon('spark') + 'Demo mode. Harness responses and checks are simulated; no repository files are changed.</div>' : ''}<div class="task-layout"><div class="task-center">${t.status === 'blocked' && t.blockerDecision ? '' : taskSummary(t, state.events)}${state.executionMapOpen ? executionMap(t, { selectedId: state.graphSelectedId, zoom: state.graphZoom }) : ''}${t.error && !(t.status === 'blocked' && t.blockerDecision) ? `<details class="error-panel" data-event-key="blocker"><summary>Blocker details</summary><p>${e(t.error)}</p></details>` : ''}${blockerDecisionView(t)}${t.status === 'awaiting_plan' ? planGate(t) : ''}${t.status === 'awaiting_final' ? `<div class="approval-panel final-panel"><div class="approval-icon">${icon('check')}</div><div><span class="eyebrow">YOUR FINAL LOOK</span><h2>The specialists are done. Over to you.</h2><p>Verification passed and independent review is complete. Inspect the handoffs and diff before accepting. Acceptance does not commit or publish; those steps follow below.</p><div class="approval-actions">${button('task-action', 'Accept result', 'primary', 'check', 'data-operation="accept"')}${button('request-changes', 'Request changes', 'secondary')}</div></div></div>` : ''}${healthPanel(t)}${publicationPanel(t)}<div class="detail-tabs relay-tabs" role="tablist">${tabIndicator}${[
    ['overview', 'Overview'],
    ['thread', 'Activity'],
    ['terminals', 'Terminals'],
    ['handoffs', 'Handoffs'],
    ['diff', 'Changes'],
    ['transcript', 'Logs'],
  ]
    .map(
      ([id, name]) =>
        `<button role="tab" aria-selected="${state.tab === id}" class="${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${name}${id === 'handoffs' ? `<span>${taskRuns(t).filter((a) => a.handoff || a.error).length}</span>` : ''}</button>`,
    )
    .join(
      '',
    )}</div><div class="detail-content" data-event-key="task-panel-${state.tab}">${state.tab === 'overview' ? completionPanel(t) + coordinationPanel(t) + (taskDetails(t) || empty('book', 'No description yet', 'Configure this task to add requirements.')) : state.tab === 'terminals' ? terminalView(t, state) : state.tab === 'thread' ? threadView(t) : state.tab === 'handoffs' ? handoffsView(t) : state.tab === 'diff' ? diffView(t) : transcriptView(t)}</div>${!['completed', 'cancelled'].includes(t.status) ? `<form id="message-form" class="message-box">${markdownEditor({ id: 'task-message', name: 'message', label: 'Add direction or context', rows: 3, max: 20000 })}<div><small>${t.canSteer ? 'Steer sends direction to the active session; Claude interrupts and resumes.' : 'Context stays pending until an agent receives it.'} ${t.messages.filter((m) => m.delivery === 'pending').length} pending.</small>${t.canSteer ? '<label><input id="steer-active" type="checkbox" name="steer" checked> Steer active agent</label>' : ''}<button class="btn secondary small" type="submit">Send direction ${icon('arrow')}</button></div></form>` : ''}${followUpComposer(t, state.config, state.followUpProviders?.[t.id], state.followUpSettings?.[t.id], state.modelCatalog)}</div><aside class="task-context">${sideChat(t, state.sideChatOpen)}${state.memoryAvailable ? runMemories(t) : ''}<section class="context-card"><div class="context-title">WORKFLOW <span class="live-label ${live ? 'is-live' : ''}">${live ? '● LIVE' : 'HISTORY'}</span></div><ol class="stage-list">${workflowStages(t)}${deliveryWorkflowStages(t)}${feedbackWorkflowStage(t)}</ol><button class="btn secondary workflow-graph-button" data-action="open-execution-map" aria-label="Open execution graph">Execution graph ↗</button>${checkpointControl(t)}</section>${(t
    .repositories?.length > 1
    ? t.repositories
    : [t]
  )
    .map((r) => workspaceCard(t, r))
    .join(
      '',
    )}${t.chosenApproach ? `<section class="context-card approved-card"><div class="context-title">APPROVED APPROACH ${icon('check')}</div><strong>${e(t.chosenApproach.title)}</strong><p>${e(t.chosenApproach.description)}</p></section>` : ''}</aside></div>`;
}
function planGate(t) {
  const plan = completedPlan(t);
  return `<div class="approval-panel"><div class="gate-heading"><div class="approval-icon">${icon('git')}</div><div><h2>Choose an approach</h2></div></div><form id="approve-form"><div class="approach-options">${planOptions(plan?.options, plan?.recommendedOptionId)}</div><label class="field-label" for="approval-note">Notes <span>(optional)</span></label><input id="approval-note" class="input" placeholder="Constraints, preferences, things to keep in mind…" maxlength="10000"><div class="approval-actions"><button class="btn primary" type="submit">Approve & implement ${icon('arrow')}</button>${button('request-changes', 'Revise the proposal', 'text')}</div></form></div>`;
}
function threadView(t) {
  const meaningful = new Set([
    'health',
    'automation',
    'auto_decision',
    'checkpoint',
    'checkpoint_failed',
    'fork',
    'quiet',
    'created',
    'configuration',
    'queued',
    'workspace',
    'stage_started',
    'activity',
    'handoff',
    'approval',
    'decision',
    'feedback',
    'blocked',
    'recovery',
    'interrupted',
    'paused',
    'cancelled',
    'accepted',
    'submission',
    'publication',
    'manual',
    'terminal',
  ]);
  const knownMessages = new Set(
    state.events
      .filter((ev) => ev.type === 'activity' && ev.kind === 'message')
      .map((ev) => `${ev.attemptId}:${ev.details || ev.summary}`),
  );
  const events = state.events.flatMap((ev) => {
    if (meaningful.has(ev.type)) return [ev];
    return (ev.agentMessages ?? [])
      .filter((message) => !knownMessages.has(`${ev.attemptId}:${message}`))
      .map((message) => ({
        ...ev,
        type: 'activity',
        kind: 'message',
        summary: message.slice(0, 1200),
        details: message,
      }));
  });
  const latestAttempt = taskRuns(t).at(-1);
  const activity = state.events.findLast(
    (ev) => ev.type === 'activity' && ev.attemptId === latestAttempt?.id,
  );
  const grouped = [];
  for (const ev of events) {
    if (ev.type === 'activity' && ev.kind !== 'message') {
      const last = grouped.at(-1);
      if (
        last?.toolEvents &&
        activityEventIdentity(last).name === activityEventIdentity(ev).name &&
        last.attemptId === ev.attemptId &&
        last.repositoryId === ev.repositoryId
      )
        last.toolEvents.push(ev);
      else grouped.push({ ...ev, toolEvents: [ev] });
    } else grouped.push(ev);
  }
  if (state.activityTaskId !== t.id) {
    state.activityTaskId = t.id;
    state.activitySelection = 'latest';
  }
  const run = activityRunSelection(t, grouped, state.activitySelection);
  const followingCurrent =
    run.selected?.id === latestAttempt?.id && state.activitySelection !== 'all';
  return `<div class="activity-browser">${activityRunNavigation(t, run.selected, state.activitySelection)}<div class="activity-run-content">${activityRunHeader(run.selected, state.events)}<div class="timeline">${run.events.map((ev) => (state.activitySelection === 'all' && activityPassoff(t, ev) ? `<article data-event-seq="${ev.seq}" class="timeline-item passoff-event"><div class="timeline-avatar">${icon('arrow')}</div><div class="timeline-body">${activityPassoff(t, ev)}${ev.repositoryId ? `<small class="passoff-repository">${e((t.repositories?.length > 1 ? t.repositories : [t]).find((r) => r.repository.id === ev.repositoryId)?.repository.name ?? ev.repositoryId)}</small>` : ''}</div></article>` : `<article data-event-seq="${ev.seq}" class="timeline-item ${ev.type === 'decision' ? 'decision-event' : ''}"><div class="timeline-avatar">${activityEventIdentity(ev).harness ? harnessBadge(activityEventIdentity(ev).harness) : icon(ev.type === 'approval' || ev.type === 'accepted' ? 'check' : ev.type === 'decision' ? 'eye' : ev.type === 'feedback' ? 'arrow' : 'layers')}</div><div class="timeline-body"><div class="event-meta">${activityEventMeta(ev, ev.stage ? (stageNames[ev.stage] ?? (ev.stage === 'publish' ? 'Publication' : ev.stage === 'feedback' ? 'PR feedback' : 'PR status')) : null)}<time>${ago(ev.at)}</time>${ev.repositoryId ? `<span>${e((t.repositories?.length > 1 ? t.repositories : [t]).find((r) => r.repository.id === ev.repositoryId)?.repository.name ?? ev.repositoryId)}</span>` : ''}</div>${ev.toolEvents ? `<details class="event-details tool-activity" data-event-key="tools-${ev.seq}"><summary>${ev.toolEvents.length} ${ev.toolEvents.length === 1 ? 'activity' : 'activities'} · ${e(concise(ev.toolEvents.at(-1).summary, 120))}</summary>${ev.toolEvents.map((tool) => `<div class="tool-entry"><strong>${e(concise(tool.summary, 180))}</strong>${tool.details ? `<pre class="code-block">${e(tool.details)}</pre>` : ''}</div>`).join('')}</details>` : ev.type === 'activity' && ev.kind === 'message' ? `<div class="prose agent-message">${prose(concise(ev.details || ev.summary, 360))}</div>${(ev.details || ev.summary).length > 360 ? `<details class="event-details" data-event-key="message-${ev.seq}"><summary>Full message</summary><div class="prose">${prose(ev.details || ev.summary)}</div></details>` : ''}` : `<h3>${e(concise(ev.summary))}</h3>`}${ev.type === 'handoff' ? `<details class="report-section" data-event-key="handoff-report-${ev.seq}"><summary>Run details &amp; evidence</summary>${handoffBodyForThread(t, ev)}</details>` : ev.details && !ev.toolEvents && ev.type !== 'activity' ? `<details data-event-key="event-${ev.seq}" class="event-details"><summary>Details</summary><div class="prose">${prose(ev.details)}</div></details>` : ''}</div></article>`)).join('')}${followingCurrent && ['running', 'queued'].includes(t.status) ? `<article class="timeline-item working"><div class="timeline-avatar">${harnessBadge(latestAttempt?.harness ?? t.routing[t.stage])}</div><div class="timeline-body"><div class="event-meta"><strong>${e(stageNames[t.stage])}</strong><span class="typing-dots"><i></i><i></i><i></i></span></div><p>${e(concise(activity?.summary || 'Preparing the next handoff…'))}</p><small>Updates appear here as work progresses.</small></div></article>` : ''}</div></div></div>`;
}
function handoffBodyForThread(t, ev) {
  return handoffBody(taskRuns(t).find((a) => a.id === ev.attemptId)?.handoff);
}
function handoffsView(t) {
  return handoffList(t);
}
function diffView(t, suppliedDiff) {
  if (t.demo)
    return empty(
      'code',
      'No real files changed',
      'Demo mode simulates the workflow. Live tasks show tracked changes and untracked files here.',
    );
  if (!t.workspace && !t.repositories?.some((r) => r.workspace))
    return t.cleanedWorkspace
      ? empty(
          'git',
          'Worktree cleaned',
          'The branch, task history and artifacts are retained. Create a checkout of the retained branch to inspect the code.',
        )
      : empty('git', 'No workspace yet', 'Start this task to prepare its workspace.');
  if (!state.diff) return '<div class="boot">Loading changes…</div>';
  const d = suppliedDiff ?? state.diff;
  const canComment = t.status === 'awaiting_final';
  if (d.repositories)
    return (
      `<div class="diff-heading"><strong>${d.repositories.length} repository diffs</strong>${button('refresh-diff', 'Refresh all', 'text small')}</div>` +
      d.repositories
        .map(
          (r) =>
            `<details open class="repository-diff"><summary>${e(r.name)}</summary>${diffView({ ...t, baseCommit: r.baseCommit }, { ...r, fingerprint: d.fingerprint })}</details>`,
        )
        .join('')
    );
  if (d.error)
    return `<section class="error-panel diff-load-error" aria-label="Changes unavailable"><div><h2>Couldn’t load changes</h2>${button('refresh-diff', 'Retry loading changes', 'secondary')}</div><details><summary>Error details</summary><pre>${e(d.error)}</pre></details></section>`;
  if (d.omitted)
    return `<div class="error-panel"><h2>Changes exceed the preview limit</h2><p>${e(d.reason)} The full diff is available in the task’s worktree.</p></div>`;
  const repositoryId = d.repositoryId ?? t.repository.id;
  const comments = (t.reviewComments || []).filter((c) => c.repositoryId === repositoryId);
  const files = diffFileGroups(d);
  if (!files.length && !comments.length && !d.text && !d.untracked.length)
    return empty(
      'check',
      'No changes yet',
      'Changes appear here as the workspace changes.',
      button('refresh-diff', 'Refresh', 'secondary small'),
    );
  return `<div class="panel-heading"><div><h2>Changes</h2><p>${files.length} ${files.length === 1 ? 'file' : 'files'} · compared with <code>${e(t.baseCommit?.slice(0, 10))}</code></p></div>${button('refresh-diff', 'Refresh', 'secondary small')}</div>${canComment ? '<div class="review-callout"><strong>Ready for your review</strong><p>Open a file and use + beside a line to leave feedback. Send open comments for a focused repair.</p></div>' : ''}<div class="diff-file-toolbar"><span>Browse files</span><button class="btn text small" data-action="expand-diff">Expand all</button><button class="btn text small" data-action="collapse-diff">Collapse all</button></div>${files.map((file, fileIndex) => `<details class="diff-file" data-event-key="diff-${e(repositoryId)}-${e(file.name)}" ${fileIndex === 0 ? 'open' : ''}><summary><span class="diff-file-name"><strong>${e(file.name.split('/').at(-1))}</strong><small>${e(file.name)}</small></span><span class="diff-count"><b>+${file.additions}</b><span>−${file.deletions}</span></span></summary><pre class="diff-code">${file.lines.map((line) => `<span class="diff-line ${line.kind} ${line.anchor ? 'has-anchor' : ''}">${canComment && line.anchor ? `<button class="diff-comment-button" data-action="comment-line" data-repository-id="${e(repositoryId)}" data-line="${line.index}" aria-label="Comment on ${e(line.anchor.path)} line ${line.anchor.line}">+</button>` : ''}${line.anchor ? `<small class="diff-line-number">${line.anchor.side === 'old' ? 'old' : 'new'} ${line.anchor.line}</small>` : ''}${e(line.text)}</span>`).join('\n')}</pre></details>`).join('')}${d.stat ? `<details class="report-section"><summary>Change statistics</summary><pre class="diff-stat">${e(d.stat)}</pre></details>` : ''}${comments.length ? `<section class="context-card"><h3>Inline feedback</h3>${comments.map((c) => `<article class="review-comment"><strong>${e(c.anchor.path)}:${c.anchor.line} · ${e(c.status)}${c.fingerprint !== d.fingerprint ? ' · Earlier workspace' : ''}</strong><div class="prose">${prose(c.text)}</div>${canComment && c.status !== 'resolved' ? button('resolve-comment', 'Mark resolved', 'text small', '', `data-comment-id="${e(c.id)}"`) : ''}</article>`).join('')}${canComment && comments.some((c) => c.status === 'open') ? button('focused-repair', 'Send all open comments for repair', 'primary small') : ''}</section>` : ''}${!d.text && !d.untracked.length ? empty('check', 'No changes yet', 'Changes appear here as the workspace changes.') : ''}`;
}
function transcriptView(t) {
  return executionLogs(t, state.events, {
    run: state.logRun,
    stream: state.logStream,
    query: state.logQuery,
  });
}
function repositoriesView() {
  return `${pageHeading('WORKSPACE', 'Repositories', 'Repository profiles and task workspaces.', button('add-repository', 'Add repository', 'primary', 'plus'))}<div class="repository-section-heading"><h2>Connected repositories</h2><span>${state.config.repositories.length} ${state.config.repositories.length === 1 ? 'profile' : 'profiles'}</span></div><div class="repository-grid">${state.config.repositories.map((r) => `<article class="repository-card"><div class="repo-card-heading"><span class="repo-icon">${icon('folder')}</span><h2>${e(r.name)}</h2>${button('edit-repository', 'Edit profile', 'text small', '', `data-id="${e(r.id)}" aria-label="Edit ${e(r.name)} profile"`)}</div><p class="repo-path mono">${e(r.path)}</p><dl class="repository-facts"><div><dt>Workspace</dt><dd>${r.strategy === 'attach' ? 'Existing checkout' : r.strategy === 'managed' ? 'Managed task worktree' : 'New worktree per task'}</dd></div><div><dt>Verification</dt><dd>${r.verificationMode !== 'commands' ? 'Agent discovers checks' : `${r.checks.length} configured ${r.checks.length === 1 ? 'command' : 'commands'}`}</dd></div><div><dt>Working directory</dt><dd class="mono">${e(r.cwd || '.')}</dd></div></dl></article>`).join('')}${!state.config.repositories.length ? empty('folder', 'Connect your first repository', 'Choose a local checkout to start real work.', button('add-repository', 'Add repository', 'primary', 'plus')) : ''}</div>${repositoryDiscoveryPanel(state.repositoryDiscovery)}`;
}
function harnessesView() {
  return `${pageHeading('WORKSPACE', 'Agents', 'Configure providers and defaults for new tasks.', button('refresh-models', 'Refresh models', 'secondary small'))}<form id="harness-form"><div class="harness-grid">${[
    'codex',
    'claude',
    'pi',
  ]
    .map((id) => {
      const h = state.config.harnesses[id];
      const available = state.harnesses.find((v) => v.id === id)?.available;
      return `<article class="harness-card"><div class="harness-card-heading">${harnessBadge(id)}<div><h2>${id === 'pi' ? 'Pi' : id === 'codex' ? 'Codex' : 'Claude Code'}</h2><small>${h.enabled ? 'Enabled' : 'Disabled'}</small></div></div><div class="availability ${available ? 'available' : ''}"><span class="status-dot"></span>${available ? 'CLI found' : 'CLI not found'}<small>Sign-in checked when a run starts</small></div><label class="field-label" for="${id}-command">Executable</label><input class="input mono" id="${id}-command" name="${id}-command" value="${e(h.command)}" required><label class="field-label" for="${id}-model">Model override <span>Optional</span></label>${modelPicker({ id: `${id}-model`, name: `${id}-model`, provider: id, value: h.model, catalog: state.modelCatalog })}<p class="model-picker-hint">${e(modelCatalogHint(state.modelCatalog, id))}</p><label class="toggle-label"><input id="${id}-enabled" type="checkbox" name="${id}-enabled" ${h.enabled ? 'checked' : ''}> Enabled for routing</label></article>`;
    })
    .join(
      '',
    )}</div><section class="routing-panel"><div><h2>Specialist routing</h2><p>Defaults for new tasks. Each task keeps its own routing.</p></div><div class="routing-grid">${Object.entries(
    state.config.routing,
  )
    .map(
      ([stage, id]) =>
        `<label>${e(stageNames[stage])}<select id="route-${stage}" class="input" name="route-${stage}">${['codex', 'claude', 'pi'].map((h) => `<option value="${h}" ${id === h ? 'selected' : ''}>${h === 'pi' ? 'Pi' : h === 'codex' ? 'Codex' : 'Claude'}</option>`).join('')}</select></label>`,
    )
    .join(
      '',
    )}</div></section><div class="form-footer"><span>Uses your installed CLIs and their existing sign-in.</span><button class="btn primary" type="submit">Save agent settings ${icon('check')}</button></div></form>${outcomesView(state.outcomes, state.config, state.outcomesRepository)}`;
}
function settingsView() {
  return `${pageHeading('MAKE IT YOURS', 'Settings', 'Local configuration, execution limits, and private integration profiles.')}<section class="settings-panel"><h2>Appearance</h2><label class="field-label" for="theme-preference">Theme</label><select id="theme-preference" class="input">${['system', 'light', 'dark'].map((value) => `<option value="${value}" ${window.RelayTheme.preference() === value ? 'selected' : ''}>${value === 'system' ? 'System' : value === 'dark' ? 'Dark' : 'Light'}</option>`).join('')}</select><label class="motion-preference"><input type="checkbox" id="low-motion" ${lowMotion() ? 'checked' : ''}> Low motion</label><p>Turn off animations and transitions. Saved in this browser.</p></section><section class="settings-panel"><h2>Notifications</h2><p>Desktop alerts for decisions, ready results, and completed investigations while Relay is open.</p><button class="btn secondary" data-action="enable-notifications">${localStorage.getItem('relay-notifications') === 'enabled' ? 'Disable desktop notifications' : 'Enable desktop notifications'}</button></section><form id="settings-form" class="settings-panel"><h2>Execution</h2><p>Control concurrency, retries, and run duration.</p><div class="settings-fields"><label>Concurrent tasks<input id="setting-concurrency" class="input" type="number" name="concurrency" min="1" max="8" value="${state.config.concurrency}" required><small>Work in different repositories concurrently.</small></label><label>Automatic repair rounds<input id="setting-rounds" class="input" type="number" name="maxRepairRounds" min="1" max="10" value="${state.config.maxRepairRounds}" required><small>Pause for your input after repeated failures.</small></label><label>Blocker recovery attempts<input id="setting-recovery" class="input" type="number" name="maxRecoveryAttempts" min="0" max="5" value="${state.config.maxRecoveryAttempts ?? 2}" required><small>Agents try to resolve blockers before asking you.</small></label><label>Stage budget (minutes)<input id="setting-timeout" class="input" type="number" name="timeoutMinutes" min="1" max="240" value="${state.config.timeoutMinutes}" required><small>Progress can extend each agent or check up to twice this budget.</small></label></div><button class="btn primary" type="submit">Save execution settings</button></form>${storageView(state.storage)}<section class="settings-panel"><h2>Private integration profiles</h2><p>Import repository profiles or a full configuration as JSON. Profiles stay on this machine.</p><div class="inline-actions">${button('import-profile', 'Import local profile', 'secondary', 'download')}${button('view-config', 'View configuration', 'text', 'code')}</div></section><details class="settings-panel local-execution-details"><summary>Local execution and privacy</summary><p>Relay listens on <code>127.0.0.1</code>. Task history, transcripts, and approvals are stored on this machine. Your harness CLIs handle authentication; Relay does not store API keys.</p><p>Harness and verification commands run with your user account. Use an isolated environment for untrusted code. Read the project README for execution and recovery details.</p></details>`;
}

function showModal(title, contents, wide = false) {
  modalReturnFocus = document.activeElement;
  document.querySelector('#modal-root').innerHTML =
    `<dialog id="dialog" class="modal ${wide ? 'wide' : ''}"><div class="modal-heading"><h2>${title}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>${contents}</dialog>`;
  const dialog = document.querySelector('#dialog');
  prepareSearchSelects(dialog);
  dialog.showModal();
  animateSurface(dialog, 'dialog');
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    animateExit(dialog, 'dialog', () => dialog.close());
  });
  syncToastLayer();
  dialog.addEventListener('close', () => {
    if (state.modal?.restoreId) {
      const previewId = state.modal.restoreId;
      state.modal.restoreId = null;
      api('/backups/discard', 'POST', { previewId }).catch(() => {});
    }
    document.querySelector('#modal-root').innerHTML = '';
    modalReturnFocus?.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        animateExit(dialog, 'dialog', () => dialog.close());
    }
  });
}
function closeModal() {
  const dialog = document.querySelector('#dialog');
  animateExit(dialog, 'dialog', () => dialog?.close());
}
function createTaskModal() {
  state.modal = {};
  showModal('Give your team a task', taskForm(null, state.config), true);
  syncTaskForm(document.querySelector('[data-task-editor]'));
}
async function configureTask(duplicate = false) {
  if (!duplicate && ['running', 'queued', 'manual'].includes(state.task.status)) {
    toast('Pausing the workflow before editing…');
    await api(`/tasks/${state.selected}/pause`, 'POST', {});
  }
  let task = await api(`/tasks/${state.selected}`);
  for (let i = 0; !duplicate && task.executionActive && i < 150; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    task = await api(`/tasks/${state.selected}`);
  }
  if (task.executionActive && !duplicate)
    throw new Error('The worker is still stopping. Try Configure task again shortly.');
  state.modal = { taskSnapshot: task, duplicate };
  showModal(
    duplicate ? 'Duplicate task' : 'Configure task',
    taskForm(task, state.config, { duplicate }),
    true,
  );
  syncTaskForm(document.querySelector('[data-task-editor]'));
}
function commandsInput(commands) {
  return commands.map((c) => JSON.stringify([c.command, ...c.args])).join('\n');
}
function parseCommands(value) {
  return value
    .split('\n')
    .filter((s) => s.trim())
    .map((line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error('Each command line must be a JSON array, for example ["npm","test"].');
      }
      if (!Array.isArray(parsed) || !parsed.length || !parsed.every((s) => typeof s === 'string'))
        throw new Error('Each command must be a nonempty JSON array of strings.');
      return { command: parsed[0], args: parsed.slice(1) };
    });
}
function repositoryModal(id, preset = {}) {
  const r = state.config.repositories.find((r) => r.id === id) || {
    name: '',
    path: '',
    cwd: '.',
    strategy: 'worktree',
    checks: [],
    setup: [],
    instructions: '',
    ...preset,
  };
  state.modal = { repositoryId: id };
  showModal(
    id ? 'Edit repository profile' : 'Connect a repository',
    repositoryProfileForm(r, id, commandsInput),
    true,
  );
  document.querySelector('#dialog').classList.add('repository-dialog');
  syncRepositoryProfile(document.querySelector('#repository-form'));
  installRepositorySuggestions(document.querySelector('#repository-form'), { api, notify: toast });
}
const refresh = refreshQueue(refreshSnapshot, { onError: (error) => toast(error.message, true) });
async function loadWorkspaceAgent() {
  const requested = state.workspaceChatId;
  const chats = await api('/workspace-agent/chats');
  if (requested !== state.workspaceChatId) return;
  const chatId = chats.some((chat) => chat.id === requested) ? requested : chats[0]?.id;
  const [messages, info] = await Promise.all([
    api(`/workspace-agent?chatId=${encodeURIComponent(chatId)}`),
    api('/workspace-agent/context'),
  ]);
  if (requested !== state.workspaceChatId) return;
  if (state.workspaceChatId !== chatId) {
    state.workspaceChatId = chatId;
    state.orchestratorDraft = readWorkspaceDraft(chatId);
  }
  state.workspaceMessages = messages;
  state.workspaceInfo = { ...info, chats, chatId };
}
async function selectRelayChat(chatId) {
  state.workspaceChatListOpen = false;
  state.workspaceChatSearch = '';
  state.workspaceChatId = chatId;
  state.orchestratorDraft = readWorkspaceDraft(chatId);
  state.workspaceMessages = [];
  for (const input of document.querySelectorAll('#workspace-request')) {
    input.value = state.orchestratorDraft;
    input.dataset.conversationId = chatId;
  }
  try {
    localStorage.setItem('relay-workspace-chat', chatId);
  } catch {}
  await loadWorkspaceAgent();
  renderMain();
  syncOrchestrator();
}

async function refreshSnapshot() {
  await pendingStatuses.sync(api);
  [state.tasks, state.inbox, state.memories] = await Promise.all([
    api('/tasks'),
    api('/inbox'),
    loadMemories(),
  ]);
  state.tasks = state.tasks.map((task) => pendingStatuses.apply(task));
  notifyInbox(state.inbox);
  notifyResults(state.tasks);
  if (state.view === 'assistant' || state.orchestratorOpen) await loadWorkspaceAgent();
  if (state.view === 'harnesses')
    state.outcomes = await api(
      `/outcomes?repositoryId=${encodeURIComponent(state.outcomesRepository)}`,
    );
  if (state.selected) {
    const selected = state.selected;
    let task;
    try {
      task = await api(`/tasks/${selected}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      if (state.selected === selected) await navigate('tasks');
      return;
    }
    if (state.selected !== selected) return;
    const baseChanged = state.task?.id === task.id && state.task.baseCommit !== task.baseCommit;
    state.task = pendingStatuses.apply(task);
    if (baseChanged) state.diff = null;
    if (baseChanged && state.tab === 'diff')
      loadDiff().catch((error) => toast(error.message, true));
    // Status and approval gates must not wait for logs or terminal capture.
    renderMain();
    let events = state.task?.id === selected ? state.events : [];
    const batch = await eventBatch(
      (after) => api(`/tasks/${selected}/events?after=${after}`),
      events.at(-1)?.seq || 0,
    );
    events = events.concat(batch.events);
    if (state.selected === selected) {
      state.task = pendingStatuses.apply(task);
      state.events = events;
      await refreshTerminal(task);
      if (batch.hasMore) refresh();
    }
  }
  renderMain();
}
async function refreshTerminal(task) {
  const selected = terminalSelection(task, state.terminalId);
  const id = selected?.id;
  state.terminalPreview = null;
  if (!id || !selected.live) return;
  try {
    const preview = await api(
      `/tasks/${task.id}/terminal-preview?attemptId=${encodeURIComponent(id)}`,
    );
    if (state.selected === task.id && terminalSelection(state.task, state.terminalId)?.id === id)
      state.terminalPreview = { ...preview, id };
  } catch (error) {
    if (state.selected === task.id)
      state.terminalPreview = { id, available: false, message: error.message };
  }
}
async function openTask(id, recordHistory = true, tab = 'overview', sideChatOpen = false) {
  if (state.selected !== id) {
    state.sideChatOpen = false;
    state.executionMapOpen = false;
    state.graphSelectedId = null;
  }
  state.sideChatOpen = sideChatOpen;
  state.selected = id;
  state.view = 'task';
  state.task = null;
  state.events = [];
  state.diff = null;
  state.tab = tab;
  state.terminalId = '';
  state.terminalPreview = null;
  state.terminalFollow = true;
  shell();
  if (recordHistory) history.pushState(null, '', taskRoute(id, state.tab, state.sideChatOpen));
  await refresh();
  if (state.selected !== id) return;
  if (state.tab === 'diff') await loadDiff();
}
async function loadModelCatalog(refresh = false) {
  if (state.modelCatalogLoading) return;
  state.modelCatalogLoading = true;
  try {
    state.modelCatalog = await api('/models/discover', 'POST', { refresh }, { timeoutMs: 30000 });
  } catch (error) {
    for (const id of ['codex', 'claude', 'pi'])
      state.modelCatalog[id] ??= { status: 'unavailable', models: [], error: error.message };
  } finally {
    state.modelCatalogLoading = false;
    renderMain();
  }
}
async function loadRepositoryDiscovery(root) {
  if (state.repositoryDiscovery?.loading) return;
  state.repositoryDiscovery = { loading: true };
  renderMain();
  try {
    state.repositoryDiscovery = await api('/repositories/discover', 'POST', root ? { root } : {}, {
      timeoutMs: 15000,
    });
  } catch (error) {
    state.repositoryDiscovery = { error: error.message };
  }
  renderMain();
}
async function navigate(view, recordHistory = true) {
  state.view = view;
  if (view === 'assistant') await loadWorkspaceAgent();
  state.selected = null;
  state.task = null;
  shell();
  if (recordHistory) history.pushState(null, '', `#${view}`);
  if (view === 'tasks') writeTaskFilters(state);
  if (view === 'repositories' && !state.repositoryDiscovery) loadRepositoryDiscovery();
  if (view === 'harnesses') {
    loadModelCatalog();
    [state.harnesses, state.outcomes] = await Promise.all([
      api('/harnesses'),
      api(`/outcomes?repositoryId=${encodeURIComponent(state.outcomesRepository)}`),
    ]);
    renderMain();
  }
}
async function saveConfig(config) {
  state.config = await api('/config', 'PUT', config);
  state.harnesses = await api('/harnesses');
}
const fetchDiff = latestLoader(
  (id) => api(`/tasks/${id}/diff`, 'GET', undefined, { timeoutMs: 60000 }),
  {
    isCurrent: (id) => state.selected === id,
    apply: (diff) => {
      state.diff = diff;
      renderMain();
    },
    fail: (error) => {
      state.diff = { error: error.message };
      renderMain();
    },
  },
);
async function loadDiff() {
  const id = state.selected;
  if (!id) return;
  state.diff = null;
  renderMain();
  await fetchDiff(id);
}

function requestTaskDeletion(task) {
  state.modal = { taskId: task.id };
  return showModal(
    'Delete this task?',
    confirmation({
      subject: task.title,
      description:
        'Permanently removes this task and its activity history from Relay. Branches, worktrees, files, and pull requests are kept. Pause any active agents first.',
      cancel: 'Keep task',
      confirm: 'Delete task',
      action: 'confirm-delete-task',
    }),
  );
}
document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  event.preventDefault();
  if (state.busy) return;
  const action = element.dataset.action;
  try {
    if (action === 'fork-checkpoint' && state.executionMapOpen) {
      state.executionMapOpen = false;
      renderMain();
    }
    if (
      await workflowControlAction(action, element, {
        task: state.task,
        api,
        refresh,
        showModal,
        closeModal,
      })
    )
      return;
    if (action === 'copy-chat-message' || action === 'edit-chat-message') {
      const scope = element.dataset.scope;
      const messages = scope === 'workspace' ? state.workspaceMessages : state.task?.sideQuestions;
      const message = messages?.find((item) => item.id === element.dataset.message);
      if (!message) throw new Error('Message is no longer available. Refresh the conversation.');
      if (action === 'copy-chat-message') {
        await navigator.clipboard.writeText(message[element.dataset.part] || '');
        toast(element.dataset.part === 'answer' ? 'Reply copied.' : 'Prompt copied.');
        return;
      }
      state.modal = { chatScope: scope, messageId: message.id, taskId: state.selected };
      showModal(
        'Edit message',
        `<form id="chat-edit-form"><label class="field-label" for="chat-edit-question">Your message</label><textarea class="input" id="chat-edit-question" ${scope === 'workspace' ? `data-task-mentions="${e(JSON.stringify(message.mentions ?? []))}"` : ''} name="question" rows="6" maxlength="10000" required>${e(message.question)}</textarea><p class="form-help">Sends a revised message. Earlier replies and actions stay in history.</p><div class="modal-footer"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Send revision</button></div></form>`,
      );
      return;
    }
    if (action === 'select-relay-chat') {
      await selectRelayChat(element.dataset.id);
      return;
    }
    if (action === 'toggle-relay-chats') {
      state.workspaceChatListOpen = !state.workspaceChatListOpen;
      renderMain();
      if (state.workspaceChatListOpen) {
        const list = document.querySelector('.relay-chat-list');
        animateSurface(list, 'content');
        list?.querySelector('input')?.focus({ preventScroll: true });
      }
      return;
    }
    if (action === 'new-relay-chat' || action === 'rename-relay-chat') {
      const chat = state.workspaceInfo?.chats?.find((chat) => chat.id === state.workspaceChatId);
      state.modal = { chatId: action === 'rename-relay-chat' ? chat?.id : null };
      showModal(
        action === 'new-relay-chat' ? 'New conversation' : 'Rename conversation',
        `<form id="relay-chat-name-form"><label class="field-label" for="relay-chat-title">Name</label><input class="input" id="relay-chat-title" name="title" maxlength="100" required value="${e(action === 'rename-relay-chat' ? chat?.title || '' : '')}" placeholder="What are we working on?"><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${action === 'new-relay-chat' ? 'Create chat' : 'Save'}</button></div></form>`,
      );
      return;
    }
    if (action === 'delete-relay-chat') {
      const chat = state.workspaceInfo.chats.find((chat) => chat.id === state.workspaceChatId);
      state.modal = { chatId: chat.id };
      showModal(
        'Delete this conversation?',
        confirmation({
          subject: chat.title,
          description:
            'Permanently removes this chat and its messages. Tasks and approved workspace memory are kept.',
          cancel: 'Keep chat',
          confirm: 'Delete chat',
          action: 'confirm-delete-relay-chat',
        }),
      );
      return;
    }
    if (action === 'confirm-delete-relay-chat') {
      const id = state.modal.chatId;
      await api(`/workspace-agent/chats/${id}`, 'DELETE');
      try {
        localStorage.removeItem(workspaceDraftKey(id));
        localStorage.removeItem(
          id === 'default' ? 'relay-workspace-mentions' : `relay-workspace-mentions:${id}`,
        );
      } catch {}
      closeModal();
      await selectRelayChat((await api('/workspace-agent/chats'))[0].id);
      return;
    }
    if (action === 'open-orchestrator') {
      await openOrchestrator();
      return;
    }
    if (action === 'close-orchestrator') {
      closeOrchestrator();
      return;
    }
    if (action === 'orchestrator-prompt') {
      const input = document.querySelector('#workspace-request');
      input.value = element.dataset.prompt;
      input.focus();
      return;
    }
    if (element.closest('#relay-orchestrator') && ['open-task', 'navigate'].includes(action))
      closeOrchestrator();
    if (action === 'workspace-agent-settings') {
      const info = state.workspaceInfo;
      if (info?.unavailable)
        throw new Error('Restart Relay to enable model settings and permissions.');
      const settings = info?.settings ?? state.config.workspaceAgent;
      const permissions = settings.permissions;
      state.modal = {};
      showModal(
        'Relay model and permissions',
        `<form id="workspace-agent-settings-form"><p class="modal-description">Workspace Relay uses Claude. These settings apply to its next message.</p><label class="field-label" for="workspace-agent-model">Model</label>${modelPicker({ id: 'workspace-agent-model', provider: 'claude', value: settings.model, catalog: state.modelCatalog, known: [state.config.harnesses.claude.model], defaultLabel: 'Use Claude agent default' })}<label class="field-label" for="workspace-agent-effort">Effort</label><select class="input" id="workspace-agent-effort" name="effort">${['', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => `<option value="${effort}" ${effort === settings.effort ? 'selected' : ''}>${effort || 'Provider default'}</option>`).join('')}</select><fieldset class="workspace-permissions"><legend>Permissions</legend>${[
          ['readSettings', 'Read all settings and repository profiles'],
          ['readMemory', 'Read approved memory'],
          ['createDrafts', 'Create draft tasks'],
          ['proposeSettings', 'Propose setting changes for your approval'],
          ['proposeTasks', 'Propose task workflows and PR feedback'],
        ]
          .map(
            ([id, label]) =>
              `<label><input type="checkbox" name="${id}" ${permissions[id] ? 'checked' : ''}>${label}</label>`,
          )
          .join(
            '',
          )}</fieldset><p class="form-help">Relay cannot approve its own changes, start workflows, or bypass implementation and final review.</p><div class="modal-footer"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save Relay settings</button></div></form>`,
      );
      return;
    }
    if (action === 'review-task-proposal') {
      const proposal = state.workspaceInfo.taskProposals.find((p) => p.id === element.dataset.id);
      if (!proposal || proposal.status !== 'pending') throw new Error('Refresh this request.');
      state.modal = { proposalId: proposal.id };
      showModal(
        'Review task changes',
        `<p>${e(proposal.reason)}</p><div class="workspace-setting-diff">${proposal.changes.map((c) => `<section><h3>${e(c.title)}</h3><strong>Current</strong><pre class="code-block">${e(JSON.stringify(c.before, null, 2))}</pre><strong>Proposed</strong><pre class="code-block">${e(JSON.stringify(c.operation === 'settings' ? c.settings : { feedback: c.enabled }, null, 2))}</pre></section>`).join('')}</div><div class="modal-footer"><button class="btn secondary" data-action="decide-task-proposal" data-decision="reject">Reject</button><button class="btn primary" data-action="decide-task-proposal" data-decision="approve">Approve changes</button></div>`,
        true,
      );
      return;
    }
    if (action === 'decide-task-proposal') {
      await api(`/workspace-agent/task-proposals/${state.modal.proposalId}`, 'POST', {
        decision: element.dataset.decision,
      });
      closeModal();
      await refresh();
      await loadWorkspaceAgent();
      return;
    }
    if (action === 'review-workspace-change') {
      const proposal = state.workspaceInfo.proposals.find((item) => item.id === element.dataset.id);
      if (!proposal || proposal.status !== 'pending')
        throw new Error('This request has already been reviewed.');
      state.modal = { proposalId: proposal.id };
      showModal(
        'Review setting changes',
        `<p class="modal-description">${e(proposal.reason)}</p><div class="workspace-setting-diff">${proposal.changes.map((change) => `<section><h3>${e(change.path.join(' → '))}</h3><div><strong>Current</strong><pre class="code-block">${e(JSON.stringify(change.before, null, 2))}</pre><strong>Proposed</strong><pre class="code-block">${e(JSON.stringify(change.after, null, 2))}</pre></div></section>`).join('')}</div><p class="form-help">Approval applies only these changes. If settings have changed since the proposal, Relay must propose again.</p><div class="modal-footer"><button class="btn secondary" data-action="decide-workspace-change" data-decision="reject">Reject</button><button class="btn primary" data-action="decide-workspace-change" data-decision="approve">Approve changes</button></div>`,
        true,
      );
      return;
    }
    if (action === 'decide-workspace-change') {
      state.busy = true;
      const result = await api(`/workspace-agent/permissions/${state.modal.proposalId}`, 'POST', {
        decision: element.dataset.decision,
      });
      state.config = result.config;
      closeModal();
      await loadWorkspaceAgent();
      renderMain();
      toast(result.status === 'approved' ? 'Settings applied.' : 'Settings change rejected.');
      return;
    }
    if (action === 'stop-workspace-agent') {
      await api('/workspace-agent/stop', 'POST', { chatId: state.workspaceChatId });
      await refresh();
      return;
    }
    if (action === 'move-board-task') {
      chooseBoardMove(element.dataset.id);
      return;
    }
    if (action === 'edit-status') {
      showModal(
        'Task status',
        `<form id="status-override-form"><label class="field-label" for="status-choice">Status</label><select class="input" id="status-choice" name="value"><option value="">Automatic</option>${Object.entries(
          overrideStatuses,
        )
          .map(
            ([value, label]) =>
              `<option value="${value}" ${state.task.statusOverride?.value === value ? 'selected' : ''}>${label}</option>`,
          )
          .join(
            '',
          )}</select><p class="form-help">Overrides the status in your task list and board. Agents keep running and approval checks still apply. Choose Automatic to follow the workflow again.</p><div class="modal-footer"><button class="btn primary" type="submit">Save status</button></div></form>`,
      );
      return;
    }
    if (action === 'follow-up-stop') {
      await api(`/tasks/${state.selected}/follow-up-stop`, 'POST', {});
      await refresh();
      return;
    }
    if (action === 'delivery-run') {
      state.tab = 'thread';
      state.activityTaskId = state.selected;
      state.activitySelection = element.dataset.id || 'latest';
      history.pushState(null, '', taskRoute(state.selected, 'thread', state.sideChatOpen));
      renderMain();
      return;
    }
    if (action === 'delivery-details') {
      showModal('PR details', publicationDetails(state.task, element.dataset.repositoryId), true);
      return;
    }
    if (action === 'memory-history' || action === 'memory-select-run') {
      showModal('Memory by run', memoryRunHistory(state.task, element.dataset.id), true);
      return;
    }
    if (['new-memory', 'edit-memory', 'task-memory'].includes(action)) {
      const memory = state.memories.find((m) => m.id === element.dataset.memory);
      state.modal = { memory };
      showModal(
        memory ? 'Edit memory' : 'Add memory',
        memoryForm(
          memory,
          state.config,
          state.tasks,
          action === 'task-memory' ? { scope: 'task', targetId: state.selected } : {},
        ),
      );
      return;
    }
    if (action === 'export-memories') {
      const blob = new Blob(
        [
          JSON.stringify(
            { version: 1, exportedAt: new Date().toISOString(), memories: state.memories },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'relay-memories.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (['approve-memory', 'toggle-memory'].includes(action)) {
      const memory = state.memories.find((m) => m.id === element.dataset.memory);
      state.busy = true;
      await api(`/memories/${memory.id}`, 'PATCH', {
        revision: memory.revision,
        status: action === 'approve-memory' || memory.status === 'disabled' ? 'active' : 'disabled',
      });
      await refresh();
      toast('Memory updated for future runs.');
      return;
    }
    if (action === 'delete-memory') {
      const memory = state.memories.find((m) => m.id === element.dataset.memory);
      state.modal = { memory };
      showModal(
        'Delete memory?',
        confirmation({
          subject: memory.title,
          description:
            'Future runs will no longer use this memory. Historical run snapshots remain in task history.',
          cancel: 'Keep memory',
          confirm: 'Delete memory',
          action: 'confirm-delete-memory',
        }),
      );
      return;
    }
    if (action === 'confirm-delete-memory') {
      state.busy = true;
      const memory = state.modal.memory;
      await api(`/memories/${memory.id}`, 'DELETE', { revision: memory.revision });
      closeModal();
      await refresh();
      toast('Memory deleted.');
      return;
    }
    if (['expand-diff', 'collapse-diff'].includes(action)) {
      document.querySelectorAll('.diff-file').forEach((el) => {
        el.open = action === 'expand-diff';
      });
      return;
    }
    if (action === 'open-feedback-activity' || action === 'open-health-run') {
      state.activityTaskId = state.selected;
      state.activitySelection = element.dataset.run || 'all';
      state.tab = 'thread';
      history.pushState(null, '', taskRoute(state.selected, state.tab, state.sideChatOpen));
      renderMain();
      return;
    }
    if (action === 'activity-run') {
      state.activitySelection = element.dataset.run;
      renderMain();
      animateSurface(document.querySelector('.activity-run-content'), 'page');
      return;
    }
    if (action === 'refresh-storage') {
      state.busy = true;
      state.storage = await api('/storage');
      renderMain();
      return;
    }
    if (action === 'preview-cleanup') {
      const entry = state.storage.entries[Number(element.dataset.entry)];
      state.modal = { cleanup: entry };
      showModal(
        'Remove this finished worktree?',
        confirmation({
          subject: `${entry.title} · ${entry.repository}`,
          description: `Remove ${bytes(entry.bytes)} of workspace files. Relay rechecks cleanliness and commit preservation. The branch, task, approvals and artifacts are retained.`,
          details: `<p class="wrap mono">${e(entry.path)}</p>`,
          cancel: 'Keep worktree',
          confirm: 'Remove clean worktree',
          action: 'confirm-cleanup',
        }),
      );
      return;
    }
    if (action === 'confirm-cleanup') {
      state.busy = true;
      await api('/storage/cleanup', 'POST', state.modal.cleanup);
      closeModal();
      state.storage = await api('/storage');
      renderMain();
      toast('Clean worktree removed; branch and history retained.');
      return;
    }
    if (action === 'create-backup') {
      state.busy = true;
      toast('Creating archive and workspace recovery snapshots…');
      const archive = await api('/backups', 'POST', {});
      showModal(
        'Backup ready',
        `<p>${archive.tasks} tasks · ${archive.files} files · ${bytes(archive.bytes)}</p><a class="btn primary" href="${e(archive.downloadUrl)}" download>Download private archive</a>`,
      );
      return;
    }
    if (action === 'confirm-restore') {
      state.busy = true;
      const restored = await api('/backups/restore', 'POST', {
        previewId: state.modal.restoreId,
        confirm: true,
      });
      state.modal.restoreId = null;
      closeModal();
      state.config = (await api('/bootstrap')).config;
      state.storage = null;
      state.selected = null;
      await refresh();
      await navigate('tasks');
      showModal(
        'Backup restored',
        `<p>${restored.tasks} tasks restored. Workflows are stopped for inspection.</p><a class="btn secondary" href="${e(restored.safetyBackup.downloadUrl)}" download>Download pre-restore safety backup</a>`,
      );
      return;
    }
    if (action === 'apply-routing-advice') {
      const report = await api(
        `/outcomes?repositoryId=${encodeURIComponent(state.outcomesRepository)}`,
      );
      const config = structuredClone(state.config);
      for (const recommendation of report.recommendations)
        config.routing[recommendation.stage] = recommendation.harness;
      await saveConfig(config);
      renderMain();
      toast('Routing defaults updated for new tasks; models preserved.');
      return;
    }
    if (action === 'feedback-toggle') {
      if (element.dataset.enabled === 'false') {
        await api(`/tasks/${state.selected}/feedback`, 'POST', {
          repositoryId: element.dataset.repositoryId,
          enabled: false,
        });
        await refresh();
        return;
      }
      await api(`/tasks/${state.selected}/feedback`, 'POST', {
        repositoryId: element.dataset.repositoryId,
        enabled: true,
      });
      await refresh();
      toast('PR feedback added to the workflow.');
      return;
    }
    if (action === 'feedback-respond') {
      state.modal = {
        feedbackId: element.dataset.feedbackId,
        feedbackRepository: element.dataset.repositoryId,
      };
      showModal(
        'Respond to PR feedback',
        `<form id="feedback-response-form"><label class="field-label" for="feedback-direction">Your direction</label><textarea class="input" id="feedback-direction" name="message" rows="4" maxlength="10000" required placeholder="Which direction should the repair take?"></textarea><p class="form-help">Relay will plan a repair for your approval.</p><div class="modal-footer"><button class="btn primary" type="submit">Plan repair</button></div></form>`,
      );
      return;
    }
    if (action === 'feedback-dismiss') {
      await api(`/tasks/${state.selected}/feedback`, 'POST', {
        repositoryId: element.dataset.repositoryId,
        dismiss: element.dataset.feedbackId,
      });
      await refresh();
      toast('Feedback marked reviewed; no external reply sent.');
      return;
    }
    if (action === 'enable-notifications') {
      if (localStorage.getItem('relay-notifications') === 'enabled') {
        localStorage.setItem('relay-notifications', 'disabled');
        renderMain();
        toast('Desktop notifications disabled.');
        return;
      }
      if (!('Notification' in window))
        throw new Error('Desktop notifications are unavailable in this browser.');
      const permission = await Notification.requestPermission();
      localStorage.setItem(
        'relay-notifications',
        permission === 'granted' ? 'enabled' : 'disabled',
      );
      toast(
        permission === 'granted'
          ? 'Notifications enabled while Relay is open.'
          : 'Notifications were not enabled.',
      );
      state.tasks = state.tasks.map((task) => pendingStatuses.apply(task));
      notifyInbox(state.inbox);
      notifyResults(state.tasks);
      renderMain();
      return;
    }
    if (action === 'inbox-decide') {
      const item = state.inbox.find((item) => item.key === element.dataset.key);
      if (!item) throw new Error('Decision changed; refresh the inbox.');
      const operation = element.dataset.operation;
      const option = item.brief.options.find((option) => option.id === element.dataset.optionId);
      if (operation === 'approve-plan' && !option)
        throw new Error('Approach is no longer available.');
      state.modal = {
        inboxDecision: {
          taskId: item.taskId,
          key: item.key,
          operation,
          optionId: option?.id,
          resolution: element.dataset.resolution,
        },
      };
      const description =
        operation === 'approve-plan'
          ? `Implement “${option.title}”? Verification and independent review follow, with your final acceptance before publication.`
          : operation === 'accept'
            ? 'Accept this independently reviewed result? Enabled PR feedback automation will publish the accepted repairs.'
            : 'Send this direction to the workflow? Your existing approval scope stays in effect.';
      showModal(
        operation === 'approve-plan' ? 'Approve implementation' : 'Confirm decision',
        confirmation({
          subject: item.title,
          description,
          tone: 'primary',
          confirm:
            operation === 'approve-plan'
              ? 'Approve approach'
              : operation === 'accept'
                ? 'Accept result'
                : 'Continue',
          action: 'inbox-confirm',
        }),
      );
      return;
    }
    if (action === 'inbox-confirm') {
      await api('/inbox/decide', 'POST', state.modal.inboxDecision);
      closeModal();
      await refresh();
      toast('Decision recorded.');
      return;
    }
    if (action === 'inbox-open' || action === 'inbox-seen') {
      await api('/inbox/seen', 'POST', { key: element.dataset.key });
      await refresh();
      if (action === 'inbox-open') await openTask(element.dataset.id);
      return;
    }
    if (action === 'board-lane') return focusBoard(element.dataset.lane);
    if (action === 'task-layout') {
      state.taskLayout = element.dataset.layout;
      localStorage.setItem('relay-task-layout', state.taskLayout);
      renderMain();
      return;
    }
    if (['markdown-tab', 'markdown-format', 'markdown-image'].includes(action)) {
      handleMarkdownAction(element);
      if (action === 'markdown-tab')
        animateSurface(
          element.closest('[data-editor]')?.querySelector('[role=tabpanel]:not([hidden])'),
          'content',
        );
      return;
    }
    if (action === 'view-image') {
      const image = element.matches('img') ? element : element.querySelector('img');
      if (!image) return;
      openImageViewer(image);
      return;
    }
    if (action === 'copy-terminal') {
      await navigator.clipboard.writeText(element.dataset.command);
      toast('Attach command copied. Paste it in your terminal.');
      return;
    }
    if (action === 'resolve-blocker') {
      await api(`/tasks/${state.selected}/resolve-blocker`, 'POST', {
        decisionId: element.dataset.decisionId,
        resolution: element.dataset.resolution,
        optionId: element.dataset.optionId,
      });
      await refresh();
      return;
    }
    if (action === 'resume-session') {
      await api(`/tasks/${state.selected}/takeover`, 'POST', {
        repositoryId: element.dataset.repositoryId,
        sessionAttemptId: element.dataset.attemptId,
      });
      state.tab = 'terminals';
      history.replaceState(null, '', taskRoute(state.selected, state.tab, state.sideChatOpen));
      await refresh();
      return;
    }
    if (action === 'takeover') {
      showModal(
        'Take control of this workspace',
        `<p class="modal-description">Relay will stop the active agent, then open a shell in this task’s worktree. Use the interactive terminal directly in the Terminals tab. You can also run your preferred harness there. Return control when ready; Relay will rerun ${state.task.chosenApproach ? 'required checks and independent review' : 'investigation and approach approval'}.</p><p class="modal-description">Closing the browser tab keeps manual control. Returning to automation closes the terminal and its processes.</p><div class="modal-footer">${button('close-modal', 'Keep automation', 'text')}${button('takeover-confirm', 'Take control', 'primary', 'code', `data-repository-id="${e(element.dataset.repositoryId)}"`)}</div>`,
      );
      return;
    }
    if (action === 'takeover-confirm') {
      await api(`/tasks/${state.selected}/takeover`, 'POST', {
        repositoryId: element.dataset.repositoryId,
      });
      closeModal();
      state.tab = 'terminals';
      history.replaceState(null, '', taskRoute(state.selected, state.tab, state.sideChatOpen));
      await refresh();
      return;
    }
    if (action === 'navigate') {
      if (element.dataset.view === 'harnesses')
        state.outcomes = await api(
          `/outcomes?repositoryId=${encodeURIComponent(state.outcomesRepository)}`,
        );
      return await navigate(element.dataset.view);
    }
    if (action === 'new-task') return createTaskModal();
    if (action === 'configure-task' || action === 'duplicate-task') {
      if (state.busy) return;
      state.busy = true;
      try {
        return await configureTask(action === 'duplicate-task');
      } finally {
        state.busy = false;
      }
    }
    if (action === 'close-modal') return closeModal();
    if (action === 'refresh-models') {
      await loadModelCatalog(true);
      return;
    }
    if (action === 'discover-repositories') {
      await loadRepositoryDiscovery();
      return;
    }
    if (action === 'add-discovered-repository') {
      repositoryModal(null, { name: element.dataset.name, path: element.dataset.path });
      return;
    }
    if (action === 'overview-filter') {
      state.filter = element.dataset.filter;
      state.search = '';
      state.repositoryFilter = '';
      state.stageFilter = '';
      await navigate('tasks');
      return;
    }
    if (action === 'clear-memory-filters') {
      state.memoryQuery = '';
      state.memoryFilter = 'all';
      const search = document.querySelector('#memory-search');
      if (search) search.value = '';
      const filter = document.querySelector('#memory-filter');
      if (filter) {
        filter.value = 'all';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
      }
      renderMain();
      return;
    }
    if (action === 'open-task') return await openTask(element.dataset.id);
    if (action === 'clear-task-filters') {
      state.filter = 'all';
      state.search = '';
      state.repositoryFilter = '';
      state.stageFilter = '';
      renderMain();
      return;
    }
    if (action === 'filter') {
      state.filter = element.dataset.filter;
      renderMain();
      animateSurface(document.querySelector('.workflow-board,.task-list,.empty-state'), 'page');
      focusBoard();
      return;
    }
    if (action === 'monitor-terminal') {
      closeModal();
      state.tab = 'terminals';
      state.terminalId = element.dataset.terminalId;
      history.pushState(null, '', taskRoute(state.selected, state.tab, state.sideChatOpen));
      await refreshTerminal(state.task);
      renderMain();
      return;
    }
    if (action === 'terminal-tab') {
      state.terminalId = element.dataset.terminalId;
      await refreshTerminal(state.task);
      renderMain();
      return;
    }
    if (action === 'terminal-follow') {
      state.terminalFollow = !state.terminalFollow;
      renderMain();
      return;
    }
    if (['open-side-chat', 'close-side-chat'].includes(action)) {
      const open = action === 'open-side-chat';
      const apply = () => {
        state.sideChatOpen = open;
        history.pushState(null, '', taskRoute(state.selected, state.tab, open));
        renderMain();
        if (open) document.querySelector('#side-question')?.focus();
      };
      if (!open) animateExit(document.querySelector('.side-chat-drawer'), 'drawer', apply);
      else {
        animateSurface(document.querySelector('.side-chat-drawer'), 'drawer');
        apply();
      }
      return;
    }
    if (['open-execution-map', 'close-execution-map'].includes(action)) {
      state.executionMapOpen = action === 'open-execution-map';
      if (state.executionMapOpen) state.graphZoom = 1;
      renderMain();
      if (state.executionMapOpen) focusGraphNode();
      return;
    }
    if (action === 'graph-current' || action === 'graph-focus') {
      if (action === 'graph-current') state.graphSelectedId = null;
      state.graphZoom = 1;
      renderMain();
      focusGraphNode();
      return;
    }
    if (action === 'graph-open-activity') {
      state.activityTaskId = state.task.id;
      state.activitySelection = element.dataset.id;
      state.executionMapOpen = false;
      state.tab = 'thread';
      history.pushState(null, '', taskRoute(state.selected, state.tab, state.sideChatOpen));
      renderMain();
      return;
    }
    if (action === 'graph-select') {
      state.graphSelectedId = element.dataset.id;
      renderMain();
      focusGraphNode();
      return;
    }
    if (action === 'graph-fit') {
      const canvas = document.querySelector('.node-graph-scroll');
      const layout = graphLayout(state.task);
      canvas.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      state.graphZoom = Math.max(
        0.15,
        Math.min(
          1,
          (canvas.clientWidth - 24) / layout.width,
          (canvas.clientHeight - 24) / layout.height,
        ),
      );
      renderMain();
      return;
    }
    if (['graph-zoom-in', 'graph-zoom-out', 'graph-reset'].includes(action)) {
      state.graphZoom =
        action === 'graph-reset'
          ? 1
          : Math.max(
              0.15,
              Math.min(1.5, state.graphZoom + (action === 'graph-zoom-in' ? 0.1 : -0.1)),
            );
      renderMain();
      focusGraphNode();
      return;
    }
    if (action === 'sync-base') {
      const update = state.task.blockerDecision?.baseUpdate;
      if (!update) return;
      await api(`/tasks/${state.selected}/sync-base`, 'POST', update);
      await refresh();
      return;
    }
    if (action === 'tab') {
      if (element.closest('dialog')) closeModal();
      if (element.closest('.follow-up-dispatch')) state.sideChatOpen = false;
      state.tab = element.dataset.tab;
      if (state.tab === 'transcript' && element.dataset.runId) state.logRun = element.dataset.runId;
      history.pushState(null, '', taskRoute(state.selected, state.tab, state.sideChatOpen));
      renderMain();
      if (state.tab === 'diff') await loadDiff();
      return;
    }
    if (action === 'comment-line') {
      const d =
        state.diff.repositories?.find((r) => r.repositoryId === element.dataset.repositoryId) ??
        state.diff;
      const anchor = diffLines(d)[Number(element.dataset.line)]?.anchor;
      if (!anchor) throw new Error('Refresh the diff before commenting.');
      showModal(
        `Comment on ${e(anchor.path)}:${anchor.line}`,
        `<form id="line-comment-form">${markdownEditor({ id: 'line-comment', name: 'text', label: 'Requested change', rows: 4, max: 10000 })}<div class="modal-footer"><button class="btn primary" type="submit">Save inline comment</button></div></form>`,
      );
      state.modal ??= {};
      state.modal.comment = {
        repositoryId: element.dataset.repositoryId,
        anchor,
        fingerprint: state.diff.fingerprint,
      };
      return;
    }
    if (action === 'resolve-comment') {
      await api(`/tasks/${state.selected}/resolve-comment`, 'POST', {
        commentId: element.dataset.commentId,
      });
      await refresh();
      return;
    }
    if (action === 'focused-repair') {
      await api(`/tasks/${state.selected}/request-changes`, 'POST', {
        note: 'Address these focused inline review requests. Keep unrelated code unchanged; run checks for the affected behavior and independent review.',
        commentIds: state.task.reviewComments.filter((c) => c.status === 'open').map((c) => c.id),
      });
      await refresh();
      return;
    }
    if (action === 'refresh-diff') return await loadDiff();
    if (action === 'add-repository' || action === 'edit-repository')
      return repositoryModal(element.dataset.id);
    if (action === 'request-changes')
      return showModal(
        'Give the team direction',
        `<form id="changes-form">${markdownEditor({ id: 'change-note', name: 'note', label: 'What should change?', rows: 5, max: 20000 })}<p class="form-help">The team will receive your feedback and return with an updated result.</p><div class="modal-footer">${button('close-modal', 'Cancel', 'text')}<button class="btn primary" type="submit">Send feedback & continue ${icon('arrow')}</button></div></form>`,
      );
    if (action === 'delete-task') return requestTaskDeletion(state.task);
    if (action === 'confirm-delete-task') {
      state.busy = true;
      const id = state.modal.taskId;
      const viewingDeleted = state.view === 'task' && state.selected === id;
      await api(`/tasks/${id}`, 'DELETE');
      if (state.selected === id) {
        state.selected = null;
        state.task = null;
      }
      closeModal();
      if (viewingDeleted) await navigate('tasks');
      await refresh();
      toast('Task deleted.');
      return;
    }
    if (action === 'confirm-cancel')
      return showModal(
        'Cancel this task?',
        confirmation({
          subject: state.task.title,
          description:
            'Execution will stop. The branch, workspace, and existing changes will be kept for you to inspect.',
          cancel: 'Keep working',
          confirm: 'Cancel task',
          action: 'task-action',
          attributes: 'data-operation="cancel"',
        }),
      );
    if (action === 'confirm-submit') {
      const repositoryId = element.dataset.repositoryId;
      const entry = (
        state.task.repositories?.length > 1 ? state.task.repositories : [state.task]
      ).find((r) => r.repository.id === repositoryId);
      return showModal(
        'Publish accepted changes?',
        `<p class="modal-description">A publication agent will inspect this branch and any existing PR, commit the accepted changes, and discover the correct provider tooling to publish a draft PR. It will handle routine rebases, conflict resolution and repairs within your approved approach. Changed source or history automatically goes through verification and independent review before publishing. Only genuine design choices or unavailable capabilities need you. Policy bypasses and merging remain outside this approval. Each repository is published separately.</p><div class="modal-footer">${button('close-modal', 'Cancel', 'text')}${button('publish-agent', 'Start publication agent', 'primary', 'git', `data-repository-id="${e(repositoryId)}"`)}</div>`,
      );
    }
    if (action === 'import-profile')
      return showModal(
        'Import a private local profile',
        `<form id="import-profile-form"><p class="modal-description">Paste a repository profile or a complete configuration. Profiles stay on this machine and are ignored by Git.</p><textarea class="input mono" name="profile" rows="14" required aria-label="Profile JSON" placeholder='{"name":"My repository","path":"/absolute/path", …}'></textarea><div class="modal-footer">${button('close-modal', 'Cancel', 'text')}<button class="btn primary" type="submit">Import profile</button></div></form>`,
        true,
      );
    if (action === 'view-config')
      return showModal(
        'Local configuration',
        `<p class="modal-description">Stored in the ignored <code>.relay/config.json</code> file.</p><pre class="code-block config-output">${e(JSON.stringify(state.config, null, 2))}</pre>`,
        true,
      );
    state.busy = true;
    element.disabled = true;
    if (action === 'demo') {
      closeModal();
      const task = await api('/tasks', 'POST', {
        title: 'Unify request defaults across callers',
        description:
          'Investigate inconsistent default handling, propose a maintainable approach, and add regression coverage for both request paths.',
        demo: true,
      });
      await openTask(task.id);
      await api(`/tasks/${task.id}/start`, 'POST', {});
      await refresh();
    }
    if (action === 'task-action') {
      await api(`/tasks/${state.selected}/${element.dataset.operation}`, 'POST', {});
      if (['start', 'resume'].includes(element.dataset.operation)) {
        state.tab = 'thread';
        history.replaceState(null, '', taskRoute(state.selected, state.tab, state.sideChatOpen));
      }
      closeModal();
      await refresh();
    }
    if (action === 'publication-monitor') {
      await api(`/tasks/${state.selected}/publication`, 'POST', {
        repositoryId: element.dataset.repositoryId,
        enabled: element.dataset.enabled === 'true',
      });
      await refresh();
    }
    if (action === 'publication-pause') {
      await api(`/tasks/${state.selected}/publish-stop`, 'POST', {});
      await refresh();
    }
    if (action === 'publish-agent') {
      await api(`/tasks/${state.selected}/publish`, 'POST', {
        repositoryId: element.dataset.repositoryId,
      });
      closeModal();
      toast('Publishing started. Follow its progress in Activity.');
      await refresh();
    }
    if (action === 'delete-repository') {
      const config = structuredClone(state.config);
      config.repositories = config.repositories.filter((r) => r.id !== element.dataset.id);
      await saveConfig(config);
      closeModal();
      renderMain();
      toast('Repository profile removed. Existing tasks retain their configuration.');
    }
    if (action === 'import-ticket') {
      const form = element.closest('form');
      const repositoryId = form.elements.namedItem('repositoryId').value;
      const imported = await api('/tickets/import', 'POST', {
        repositoryId,
        ticket: form.elements.namedItem('ticket').value,
      });
      for (const key of ['title', 'description', 'ticket'])
        form.elements.namedItem(key).value = imported[key] ?? '';
      for (const editor of form.querySelectorAll('[data-editor]'))
        if (editor.querySelector('[data-mode="preview"]').getAttribute('aria-selected') === 'true')
          handleMarkdownAction(editor.querySelector('[data-mode="preview"]'));
      toast(
        imported.warnings?.length
          ? `Issue imported. ${imported.warnings.join(' ')}`
          : 'Issue and discussion imported. Review the description before saving.',
      );
      return;
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.busy = false;
    element.disabled = false;
  }
});
document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'workspace-agent-form') return;
  if (form.querySelector('[data-uploading]')) {
    toast('Wait for the image uploads to finish before saving.', true);
    return;
  }
  if (state.busy || !form.reportValidity()) return;
  const data = new FormData(form);
  const values = Object.fromEntries(data);
  state.busy = true;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (form.id === 'board-move-form') {
      const id = state.modal.boardTaskId;
      const lane = data.get('lane');
      closeModal();
      await moveBoardTask(id, lane);
      return;
    }
    if (form.id === 'status-override-form') {
      const value = form.elements.namedItem('value').value || null;
      let pending = false;
      try {
        await api(`/tasks/${state.selected}/status-override`, 'POST', { value });
        pendingStatuses.clear(state.selected);
      } catch (error) {
        if (error.status !== 404) throw error;
        pendingStatuses.set(state.selected, value);
        pending = true;
      }
      closeModal();
      await refresh();
      toast(
        pending
          ? 'Status saved in this browser. It will sync when the active run finishes.'
          : 'Task status updated.',
      );
      return;
    }
    if (form.id === 'memory-form') {
      const memory = state.modal?.memory;
      const separator = values.scopeTarget.indexOf(':');
      const scope = separator < 0 ? 'global' : values.scopeTarget.slice(0, separator);
      const payload = {
        title: values.title,
        content: values.content,
        evidence: values.evidence,
        scope,
        targetId: separator < 0 ? '' : values.scopeTarget.slice(separator + 1),
        kind: values.kind,
        status: values.status,
        expiresAt: values.expiresAt ? new Date(values.expiresAt + 'Z').toISOString() : null,
      };
      if (memory) payload.revision = memory.revision;
      await api(
        memory ? `/memories/${memory.id}` : '/memories',
        memory ? 'PATCH' : 'POST',
        payload,
      );
      closeModal();
      await refresh();
      toast('Memory saved for future runs.');
      return;
    }
    if (form.id === 'backup-preview-form') {
      const file = document.querySelector('#backup-file').files[0];
      if (!file) throw new Error('Choose a backup.');
      if (file.size > 512 * 1024 * 1024) throw new Error('Backup exceeds 512 MB.');
      const response = await fetch('/api/backups/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', 'X-Relay-Token': state.token },
        body: file,
      });
      const preview = await response.json();
      if (!response.ok) throw new Error(preview.error);
      state.modal = { restoreId: preview.id };
      showModal(
        'Review this restore',
        confirmation({
          subject: `${preview.tasks} tasks · ${preview.events} events · ${preview.files} files`,
          description:
            'This replaces current Relay history, profiles and assets. A safety archive is created first. Existing checkouts stay in place; unfinished workflows need explicit resume.',
          details: `<p>${e(preview.external)}</p><details><summary>Repository paths and configured commands</summary><pre class="code-block">${e(JSON.stringify(preview.repositories, null, 2))}</pre></details>`,
          confirm: 'Restore this backup',
          action: 'confirm-restore',
        }),
        true,
      );
    }
    if (form.id === 'line-comment-form') {
      await api(`/tasks/${state.selected}/review-comment`, 'POST', {
        ...state.modal.comment,
        text: values.text,
      });
      closeModal();
      await refresh();
      await loadDiff();
      toast('Inline feedback saved.');
    }
    if (['create-task-form', 'edit-task-form'].includes(form.id)) {
      const editing = form.id === 'edit-task-form';
      const snapshot = state.modal?.taskSnapshot;
      const payload = readTaskForm(
        form,
        state.config,
        parseCommands,
        editing ? snapshot : undefined,
      );
      if (editing) payload.expectedRevision = snapshot.configRevision ?? 0;
      if (snapshot?.demo) {
        payload.repositoryIds = [];
        payload.repositorySettings = [];
        delete payload.repositoryId;
        payload.dependencies = [];
        if (!editing) payload.demo = true;
      }
      const task = await api(
        editing ? `/tasks/${snapshot.id}` : '/tasks',
        editing ? 'PATCH' : 'POST',
        payload,
      );
      closeModal();
      await openTask(task.id);
      if (editing)
        toast(
          task.status === 'paused'
            ? 'Settings saved. Resume when ready to rebuild validation and approval.'
            : 'Task settings saved.',
        );
    }
    if (form.id === 'approve-form') {
      await api(`/tasks/${state.selected}/approve-plan`, 'POST', {
        optionId: data.get('optionId'),
        note: document.querySelector('#approval-note').value,
      });
      await refresh();
    }
    if (form.id === 'changes-form') {
      await api(`/tasks/${state.selected}/request-changes`, 'POST', values);
      closeModal();
      await refresh();
    }
    if (form.id === 'feedback-response-form') {
      const task = await api(`/tasks/${state.selected}`);
      const entry = (task.repositories?.length > 1 ? task.repositories : [task]).find(
        (e) => e.repository.id === state.modal.feedbackRepository,
      );
      const record = entry?.feedbackAutopilot?.current;
      if (record?.id !== state.modal.feedbackId) throw new Error('Feedback changed; refresh.');
      await api(`/tasks/${state.selected}/follow-up`, 'POST', {
        mode: 'changes',
        feedbackId: record.id,
        message:
          'Respond to the recorded PR feedback within this task. User direction: ' +
          data.get('message') +
          '\n\nFeedback:\n' +
          record.items
            .map((i) => i.summary + '\n' + i.details + '\n' + i.url)
            .join('\n\n')
            .slice(0, 9000),
      });
      closeModal();
      await refresh();
      return;
    }
    if (form.id === 'follow-up-form') {
      const run = await api(`/tasks/${state.selected}/follow-up`, 'POST', {
        message: data.get('message'),
        provider: data.get('provider'),
        model: data.get('model'),
        effort: data.get('effort'),
      });
      form.querySelector('textarea').value = '';
      state.sideChatOpen = false;
      state.tab = 'thread';
      state.activityTaskId = state.selected;
      state.activitySelection = run.id;
      history.pushState(null, '', taskRoute(state.selected, state.tab));
      await refresh();
      return;
    }
    if (form.id === 'relay-chat-name-form') {
      const id = state.modal.chatId;
      const chat = await api(
        id ? `/workspace-agent/chats/${id}` : '/workspace-agent/chats',
        id ? 'PATCH' : 'POST',
        { title: values.title },
      );
      closeModal();
      if (id) {
        await loadWorkspaceAgent();
        renderMain();
      } else await selectRelayChat(chat.id);
      return;
    }
    if (form.id === 'workspace-agent-settings-form') {
      state.config = await api('/workspace-agent/settings', 'PATCH', {
        model: values.model,
        effort: values.effort,
        permissions: Object.fromEntries(
          ['readSettings', 'readMemory', 'createDrafts', 'proposeSettings', 'proposeTasks'].map(
            (permission) => [permission, data.has(permission)],
          ),
        ),
      });
      closeModal();
      await loadWorkspaceAgent();
      renderMain();
      toast('Relay settings saved for the next message.');
      return;
    }
    if (form.id === 'chat-edit-form') {
      const { chatScope, messageId, taskId } = state.modal;
      await api(
        chatScope === 'workspace' ? '/workspace-agent' : `/tasks/${taskId}/question`,
        'POST',
        {
          question:
            chatScope === 'workspace'
              ? composedQuestion(form.querySelector('textarea'))
              : values.question,
          revisionOf: messageId,
          ...(chatScope === 'workspace'
            ? {
                mentions: submittedMentions(form.querySelector('textarea')),
                chatId: state.workspaceChatId,
              }
            : {}),
        },
      );
      closeModal();
      await refresh();
      return;
    }
    if (form.id === 'side-question-form') {
      await api(`/tasks/${state.selected}/question`, 'POST', { question: values.question });
      document.querySelector('#side-question').value = '';
      await refresh();
      toast('Side question started. Your worker continues unchanged.');
    }
    if (form.id === 'message-form') {
      await api(`/tasks/${state.selected}/${data.has('steer') ? 'steer' : 'message'}`, 'POST', {
        message: document.querySelector('#task-message').value,
      });
      document.querySelector('#task-message').value = '';
      await refresh();
      toast(
        data.has('steer')
          ? 'Direction sent to the native session.'
          : 'Context saved; pending until the next agent.',
      );
    }
    if (form.id === 'repository-form') {
      await api('/repositories/inspect', 'POST', { path: values.path, cwd: values.cwd });
      const config = structuredClone(state.config);
      const existing = config.repositories.find((r) => r.id === state.modal?.repositoryId);
      const profile = {
        ...values,
        id: existing?.id,
        checks: parseCommands(values.checks),
        setup: parseCommands(values.setup),
        workspaceCommand: parseCommands(values.workspaceCommand)[0] || null,
        issueCommand: parseCommands(values.issueCommand)[0] || null,
        prCommand: parseCommands(values.prCommand)[0] || null,
      };
      if (existing) Object.assign(existing, profile);
      else config.repositories.push(profile);
      await saveConfig(config);
      closeModal();
      renderMain();
      state.repositoryDiscovery = null;
      loadRepositoryDiscovery();
      toast('Repository profile saved.');
    }
    if (form.id === 'repository-discovery-form') {
      await loadRepositoryDiscovery(data.get('root'));
      return;
    }
    if (form.id === 'harness-form') {
      const config = structuredClone(state.config);
      for (const id of ['codex', 'claude', 'pi'])
        config.harnesses[id] = {
          command: values[`${id}-command`],
          model: values[`${id}-model`],
          enabled: data.has(`${id}-enabled`),
        };
      for (const stage of Object.keys(config.routing))
        config.routing[stage] = values[`route-${stage}`];
      await saveConfig(config);
      renderMain();
      toast('Agent settings saved.');
    }
    if (form.id === 'settings-form') {
      const config = structuredClone(state.config);
      for (const k of ['concurrency', 'maxRepairRounds', 'timeoutMinutes', 'maxRecoveryAttempts'])
        config[k] = Number(values[k]);
      await saveConfig(config);
      toast('Execution settings saved.');
    }
    if (form.id === 'import-profile-form') {
      let raw;
      try {
        raw = JSON.parse(values.profile);
      } catch {
        throw new Error('Enter valid profile JSON.');
      }
      const config = raw.repositories
        ? raw
        : {
            ...state.config,
            repositories: [
              ...state.config.repositories.filter((r) => !raw.id || r.id !== raw.id),
              raw,
            ],
          };
      await saveConfig(config);
      closeModal();
      renderMain();
      toast('Local profile imported.');
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.busy = false;
    if (submit) submit.disabled = false;
  }
});
document.addEventListener('change', async (event) => {
  if (event.target.id === 'theme-preference') {
    window.RelayTheme.set(event.target.value);
    return;
  }
  if (event.target.id === 'low-motion') {
    setLowMotion(event.target.checked);
    return;
  }
  if (event.target.id === 'memory-filter') {
    state.memoryFilter = event.target.value;
    renderMain();
    return;
  }
  if (['log-run', 'log-stream'].includes(event.target.id)) {
    state[event.target.id === 'log-run' ? 'logRun' : 'logStream'] = event.target.value;
    renderMain();
    return;
  }
  if (['model', 'effort'].includes(event.target.name) && event.target.closest('#follow-up-form')) {
    const form = event.target.closest('form'),
      provider = new FormData(form).get('provider');
    const options = ((state.followUpSettings ??= {})[state.selected] ??= {});
    (options[provider] ??= {})[event.target.name] = event.target.value;
    return;
  }
  if (event.target.name === 'provider' && event.target.closest('#follow-up-form')) {
    (state.followUpProviders ??= {})[state.selected] = event.target.value;
    renderMain();
    return;
  }
  if (event.target.id === 'terminal-run') {
    state.terminalId = event.target.value;
    await refreshTerminal(state.task);
    renderMain();
    return;
  }
  if (event.target.id === 'outcomes-repository') {
    state.outcomesRepository = event.target.value;
    try {
      state.outcomes = await api(
        `/outcomes?repositoryId=${encodeURIComponent(state.outcomesRepository)}`,
      );
      renderMain();
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  const filters = {
    'task-repository-filter': 'repositoryFilter',
    'task-stage-filter': 'stageFilter',
    'task-sort': 'taskSort',
  };
  if (filters[event.target.id]) {
    state[filters[event.target.id]] = event.target.value;
    renderMain();
    return;
  }
  if (event.target.id === 'show-empty-stages') {
    state.showEmptyStages = event.target.checked;
    renderMain();
    return;
  }
  if (event.target.closest('[data-task-editor]')) syncTaskForm(event.target.closest('form'));
});
document.addEventListener('input', (event) => {
  if (event.target.name === 'model' && event.target.closest('#follow-up-form')) {
    const provider = new FormData(event.target.closest('form')).get('provider');
    const options = ((state.followUpSettings ??= {})[state.selected] ??= {});
    (options[provider] ??= {}).model = event.target.value;
  }
  if (event.target.id === 'memory-search') {
    state.memoryQuery = event.target.value;
    renderMain();
    return;
  }
  if (event.target.id === 'log-search') {
    state.logQuery = event.target.value;
    renderMain();
    return;
  }
  if (event.target.id === 'task-search') {
    state.search = event.target.value;
    renderMain();
    focusBoard();
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.key.toLowerCase() === 'n' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !state.executionMapOpen &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) &&
    !document.querySelector('dialog[open]')
  ) {
    event.preventDefault();
    createTaskModal();
  }
});
document.addEventListener('keydown', (event) => {
  if (['Enter', ' '].includes(event.key) && event.target.matches('[data-action=graph-select]')) {
    event.preventDefault();
    event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  if (
    event.key === 'Escape' &&
    !document.querySelector('dialog[open]') &&
    (state.sideChatOpen || state.executionMapOpen)
  ) {
    const closeChat = state.sideChatOpen;
    const complete = () => {
      state.sideChatOpen = false;
      state.executionMapOpen = false;
      if (closeChat) history.pushState(null, '', taskRoute(state.selected, state.tab));
      renderMain();
    };
    if (closeChat) animateExit(document.querySelector('.side-chat-drawer'), 'drawer', complete);
    else complete();
  }
});
window.addEventListener('popstate', () => {
  const hash = location.hash.slice(1).split('?')[0];
  if (hash === 'tasks') Object.assign(state, readTaskFilters(location.hash));
  const route = parseTaskRoute(location.hash);
  if (route && state.view === 'task' && state.selected === route.id && state.task) {
    state.tab = route.tab;
    state.sideChatOpen = route.sideChatOpen === true;
    renderMain();
    if (state.tab === 'diff') loadDiff().catch((error) => toast(error.message, true));
    return;
  }
  const operation = route
    ? openTask(route.id, false, route.tab, route.sideChatOpen === true)
    : navigate(
        ['tasks', 'inbox', 'repositories', 'harnesses', 'settings', 'memory', 'assistant'].includes(
          hash,
        )
          ? hash
          : 'overview',
        false,
      );
  operation.catch((error) => toast(error.message, true));
});
function connect() {
  stream = new EventSource('/api/events');
  stream.onopen = () => {
    state.connected = true;
    updateConnection();
    refresh().catch(() => {});
  };
  stream.onerror = () => {
    state.connected = false;
    updateConnection();
  };
  stream.onmessage = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh().catch((error) => toast(error.message, true));
    }, 150);
  };
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});
window.addEventListener('focus', () => refresh().catch(() => {}));
function updateConnection() {
  const el = document.querySelector('.connection');
  if (el)
    el.innerHTML = `<span class="local-dot ${state.connected ? '' : 'offline'}"></span><span>${state.connected ? 'Connected locally' : 'Reconnecting…'}</span><small>v0.1</small>`;
}
async function boot() {
  try {
    const bootstrap = await api('/bootstrap');
    state.token = bootstrap.token;
    state.config = bootstrap.config;
    [state.tasks, state.harnesses, state.memories] = await Promise.all([
      api('/tasks'),
      api('/harnesses'),
      loadMemories(),
    ]);
    const hash = location.hash.slice(1).split('?')[0];
    if (hash === 'tasks') Object.assign(state, readTaskFilters(location.hash));
    if (hash.startsWith('task/'))
      await openTask(
        parseTaskRoute(location.hash)?.id ?? hash.slice(5),
        false,
        parseTaskRoute(location.hash)?.tab,
        parseTaskRoute(location.hash)?.sideChatOpen === true,
      );
    else {
      state.view = [
        'assistant',
        'overview',
        'tasks',
        'inbox',
        'repositories',
        'harnesses',
        'settings',
        'memory',
      ].includes(hash)
        ? hash
        : 'overview';
      if (state.view === 'assistant') await loadWorkspaceAgent();
      shell();
    }
    loadModelCatalog();
    if (state.view === 'repositories') loadRepositoryDiscovery();
    state.inbox = await api('/inbox');
    if (state.view === 'harnesses') {
      state.outcomes = await api('/outcomes');
      renderMain();
    }
    if (state.view === 'inbox') renderMain();
    state.tasks = state.tasks.map((task) => pendingStatuses.apply(task));
    notifyInbox(state.inbox);
    notifyResults(state.tasks);
    connect();
    setInterval(() => updateTimers(), 1000);
    setInterval(() => {
      if (!document.hidden && !state.busy) refresh().catch(() => {});
    }, 5000);
  } catch (error) {
    app.innerHTML = `<div class="boot"><h1>Couldn’t connect to Relay.</h1><p>${e(error.message)}</p><p>Check the server terminal, then reload this page.</p></div>`;
  }
}
installImageUploads({ getToken: () => state.token, onError: (message) => toast(message, true) });
// Reading older terminal output pauses follow instead of snapping back on refresh.
document.addEventListener(
  'scroll',
  (event) => {
    const preview = event.target;
    if (!preview.matches?.('.terminal-preview') || !state.terminalFollow) return;
    if (preview.scrollHeight - preview.clientHeight - preview.scrollTop > 24) {
      state.terminalFollow = false;
      document
        .querySelector('[data-action="terminal-follow"]')
        ?.setAttribute('aria-pressed', 'false');
    }
  },
  true,
);
document.addEventListener('relay-images-updated', () => renderMain());
installTaskMentions(() => state.tasks);
boot();

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'workspace-agent-form') return;
  event.preventDefault();
  const form = event.target,
    chatId = state.workspaceChatId,
    button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    await api('/workspace-agent', 'POST', {
      chatId,
      question: composedQuestion(form.querySelector('textarea')),
      mentions: submittedMentions(form.querySelector('textarea')),
    });
    clearComposerMentions(form.querySelector('textarea'));
    form.reset();
    if (state.workspaceChatId === chatId) state.orchestratorDraft = '';
    try {
      localStorage.removeItem(workspaceDraftKey(chatId));
    } catch {}
    await refresh();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
});

function closeOrchestrator() {
  const dialog = document.getElementById('relay-orchestrator');
  animateExit(dialog, 'drawer', () => {
    state.orchestratorOpen = false;
    dialog?.close();
  });
}
async function openOrchestrator() {
  if (state.view === 'assistant') {
    document.getElementById('workspace-request')?.focus();
    return;
  }
  await loadWorkspaceAgent();
  state.orchestratorOpen = true;
  document
    .querySelector('[data-action="open-orchestrator"]')
    ?.setAttribute('aria-expanded', 'true');
  syncOrchestrator();
  document.getElementById('workspace-request')?.focus();
}
function syncOrchestrator() {
  if (!state.orchestratorOpen) return;
  let dialog = document.getElementById('relay-orchestrator');
  const fresh = !dialog;
  if (!dialog) {
    document.getElementById('orchestrator-root').innerHTML =
      `<dialog id="relay-orchestrator" class="orchestrator-dialog" aria-labelledby="orchestrator-dialog-title"><header>${icon('relay')}<strong id="orchestrator-dialog-title">Relay orchestrator</strong><button class="icon-button" data-action="close-orchestrator" aria-label="Close Relay orchestrator">${icon('close')}</button></header><div class="orchestrator-dialog-body"></div></dialog>`;
    dialog = document.getElementById('relay-orchestrator');
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeOrchestrator();
    });
    dialog.addEventListener('close', () => {
      state.orchestratorDraft =
        dialog.querySelector('#workspace-request')?.value ?? state.orchestratorDraft;
      state.orchestratorOpen = false;
      dialog.remove();
      document
        .querySelector('[data-action="open-orchestrator"]')
        ?.setAttribute('aria-expanded', 'false');
      syncToastLayer();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        const r = dialog.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          closeOrchestrator();
      }
    });
  }
  const body = dialog.querySelector('.orchestrator-dialog-body');
  const input = body.querySelector('#workspace-request');
  const draft = input?.value ?? state.orchestratorDraft ?? '';
  const focused = document.activeElement === input,
    start = input?.selectionStart,
    end = input?.selectionEnd;
  const messages = body.querySelector('.workspace-messages');
  const top = messages?.scrollTop;
  const follow =
    !messages || messages.scrollHeight - messages.clientHeight - messages.scrollTop < 48;
  updateLiveDOM(
    body,
    workspaceAgentView(state.workspaceMessages, state.tasks, {
      compact: true,
      info: {
        ...state.workspaceInfo,
        chatListOpen: state.workspaceChatListOpen,
        chatSearch: state.workspaceChatSearch,
      },
    }),
    'orchestrator',
  );
  const next = body.querySelector('#workspace-request');
  next.value = draft;
  syncTaskComposer(next);
  if (focused) {
    next.focus({ preventScroll: true });
    next.setSelectionRange(start, end);
  }
  const nextMessages = body.querySelector('.workspace-messages');
  if (nextMessages) nextMessages.scrollTop = follow ? nextMessages.scrollHeight : (top ?? 0);
  if (!dialog.open) {
    dialog.showModal();
    animateSurface(dialog, 'drawer');
    syncToastLayer();
  } else if (fresh) animateSurface(dialog, 'drawer');
}
document.addEventListener('input', (event) => {
  if (event.target.matches('.relay-chat-search input')) {
    state.workspaceChatSearch = event.target.value;
    const query = event.target.value.trim().toLowerCase();
    for (const list of document.querySelectorAll('.relay-chat-list')) {
      let matches = 0;
      for (const item of list.querySelectorAll('.relay-chat-item')) {
        item.hidden = !item.dataset.chatTitle.includes(query);
        if (!item.hidden) matches++;
      }
      list.querySelector('.relay-chat-no-results').hidden = matches > 0;
    }
  }
  if (event.target.id === 'workspace-request') {
    state.orchestratorDraft = event.target.value;
    try {
      localStorage.setItem(workspaceDraftKey(state.workspaceChatId), event.target.value);
    } catch {}
  }
});
document.addEventListener('keydown', (event) => {
  if (
    !state.executionMapOpen &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 'k'
  ) {
    event.preventDefault();
    if (state.orchestratorOpen) closeOrchestrator();
    else if (!document.querySelector('#dialog[open]'))
      openOrchestrator().catch((error) => toast(error.message, true));
  }
});
document.addEventListener('relay-chat-settled', () => renderMain());
document.addEventListener('click', (event) => {
  if (event.target.closest('#relay-orchestrator a[href^="#task/"]')) closeOrchestrator();
});

installTaskContextMenu({
  onError: (error) => toast(error.message, true),
  select: async (action, id) => {
    if (action === 'copy') {
      await navigator.clipboard.writeText(new URL(taskRoute(id, 'overview'), location.href).href);
      toast('Task link copied.');
      return;
    }
    if (action === 'delete')
      return requestTaskDeletion(
        state.tasks.find((t) => t.id === id) ?? (await api(`/tasks/${id}`)),
      );
    await openTask(id);
    if (action === 'duplicate') await configureTask(true);
  },
});

function readWorkspaceChatId() {
  try {
    return localStorage.getItem('relay-workspace-chat') || 'default';
  } catch {
    return 'default';
  }
}
function workspaceDraftKey(id = 'default') {
  return id === 'default' ? 'relay-workspace-draft' : `relay-workspace-draft:${id}`;
}
function readWorkspaceDraft(id = 'default') {
  try {
    return localStorage.getItem(workspaceDraftKey(id)) || '';
  } catch {
    return '';
  }
}

document.addEventListener('keydown', (event) => {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    !event.target.matches('#workspace-request,#side-question,#chat-edit-question')
  )
    return;
  event.preventDefault();
  const form = event.target.form;
  const submit = form?.querySelector('[type=submit]');
  if (submit && !submit.disabled) form.requestSubmit(submit);
});

document.addEventListener(
  'keydown',
  (event) => {
    if (
      event.key !== 'Escape' ||
      !state.workspaceChatListOpen ||
      document.querySelector('#dialog[open]')
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    state.workspaceChatListOpen = false;
    renderMain();
    document
      .querySelector('.relay-chat-mobile-bar [data-action="toggle-relay-chats"]')
      ?.focus({ preventScroll: true });
  },
  true,
);
