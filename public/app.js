import { statusQueue } from './pending-status.js';
const pendingStatuses = statusQueue(localStorage);
import { displayStatus, overrideStatuses } from './task-status.js';
import { taskRuns } from './task-runs.js';
import { publicationPanel, deliveryWorkflowStages, publicationDetails } from './publication.js';
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
} from './activity-runs.js';
import { taskRoute, parseTaskRoute } from './task-route.js';
import { executionMap } from './execution-map.js';
import { liveProgress, timer, updateTimers } from './live-progress.js';
import { sideChat } from './side-chat.js';
import { blockerDecisionView } from './blocker-decision.js';
import { taskSummary, concise } from './task-summary.js';
import { storageView, bytes } from './storage.js';
import { outcomesView } from './outcomes.js';
import { diffLines, diffFileGroups } from './diff-lines.js';
import { inboxPage, notifyInbox } from './inbox.js';
import { installImageUploads, openImageViewer } from './image-uploads.js';
import { tasksPage } from './tasks.js';
import { taskForm, syncTaskForm, readTaskForm } from './task-editor.js';
import { markdownEditor, handleMarkdownAction } from './markdown.js';
import { issueLink, taskDetails } from './task-details.js';
import { terminalView, terminalSelection } from './terminals.js';
import { syncBrowserTerminal } from './browser-terminal.js';
import {
  e,
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
async function api(path, method = 'GET', data) {
  const response = await fetch(`/api${path}`, {
    method,
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
function toast(message, error = false) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.className = error ? 'show error' : 'show';
  clearTimeout(element.timer);
  element.timer = setTimeout(() => (element.className = ''), 6500);
}
function button(action, label, kind = '', iconName = '', attrs = '') {
  return `<button class="btn ${kind}" data-action="${action}" ${attrs}>${iconName ? icon(iconName) : ''}${label}</button>`;
}
function nav(view, label, name, extra = '') {
  return `<button class="nav-item ${state.view === view ? 'active' : ''}" data-action="navigate" data-view="${view}">${icon(name)}<span>${label}</span>${extra}</button>`;
}
function shell() {
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="#" data-action="navigate" data-view="overview"><span class="brand-mark">${icon('relay')}</span>relay<span class="brand-caption">WORKBENCH</span></a><div class="workspace-label"><span class="workspace-avatar">Y</span><div>Your workspace<small>Local · Personal</small></div><span class="local-dot"></span></div><div class="nav-label">WORKSPACE</div><nav>${nav('overview', 'Overview', 'grid')}${nav('tasks', 'All tasks', 'layers', `<span class="nav-count">${state.tasks.length}</span>`)}${nav('inbox', 'Approval inbox', 'eye')}${nav('repositories', 'Repositories', 'folder')}${nav('harnesses', 'Harnesses', 'bolt')}${nav('memory', 'Memory', 'book')}</nav><div class="sidebar-bottom"><div class="sidebar-note">${icon('spark')}<p>Different minds.<br>One shared workspace.</p></div>${nav('settings', 'Settings', 'settings')}<div class="connection"><span class="local-dot ${state.connected ? '' : 'offline'}"></span><span>${state.connected ? 'Connected locally' : 'Reconnecting…'}</span><small>v0.1</small></div></div></aside><div class="main-shell"><header class="topbar"><div class="breadcrumb">Workspace ${icon('chevron')} <span>${state.view === 'task' ? 'Task workspace' : state.view.charAt(0).toUpperCase() + state.view.slice(1)}</span></div><div class="top-actions"><span class="keyboard-hint">N <span>new task</span></span>${button('new-task', 'New task', 'primary small', 'plus')}</div></header><main id="main"></main></div>`;
  renderMain();
}
function renderMain() {
  const main = document.querySelector('#main');
  if (!main || main.querySelector('[data-uploading]')) return;
  const editorModes = [...main.querySelectorAll('[data-editor]')].map((el) => ({
    id: el.dataset.editor,
    preview: el.querySelector('[data-mode="preview"]')?.getAttribute('aria-selected') === 'true',
  }));
  const panelScroll = ['.node-graph-scroll', '.graph-inspector', '.side-chat-history'].map(
    (selector) => {
      const node = main.querySelector(selector);
      return { selector, top: node?.scrollTop, left: node?.scrollLeft };
    },
  );
  const scroll = main.scrollTop;
  const terminalScroll = main.querySelector('.terminal-preview')?.scrollTop;
  const descriptionScroll = main.querySelector('.task-description')?.scrollTop;
  const boardScroll = main.querySelector('.workflow-board')?.scrollLeft;
  const focused = document.activeElement;
  const focusId = main.contains(focused) ? focused.id : null;
  const terminalFocused = !!focused?.closest('[data-browser-terminal]');
  const inputs = [...main.querySelectorAll('textarea,input')]
    .filter((i) => i.id && i.id !== 'task-search' && i.type !== 'file')
    .map((i) => ({
      id: i.id,
      value: i.value,
      start: i.selectionStart,
      end: i.selectionEnd,
      checked: i.checked,
    }));
  const expanded = new Map(
    [...main.querySelectorAll('details[data-event-key]')].map((d) => [d.dataset.eventKey, d.open]),
  );
  const selectedApproach = main.querySelector('input[name="optionId"]:checked')?.value;
  const markup =
    state.view === 'memory'
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
  updateLiveDOM(main, markup, `${state.view}:${state.selected ?? ''}:${state.tab}`);
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
  main.scrollTop = scroll;
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
  return `${pageHeading('YOUR DEVELOPMENT, ORCHESTRATED', `${greeting} Let’s make progress.`, 'Give your specialists a task. Stay in control of the decisions.', button('demo', 'Try a demo', 'secondary', 'spark'))}<div class="stats-grid"><div class="stat-card"><span>In motion</span>${icon('bolt')}<strong>${c.active.length}<small>active workflows</small></strong><div class="stat-foot">${c.active.length ? 'Your specialists are on it' : 'Ready when you are'}</div></div><div class="stat-card attention"><span>Needs your input</span>${icon('eye')}<strong>${c.waiting.length}<small>decisions & blockers</small></strong><div class="stat-foot">${c.waiting.length ? 'A little direction goes a long way' : 'Nothing waiting on you'}</div></div><div class="stat-card"><span>Completed</span>${icon('check')}<strong>${c.complete.length}<small>accepted results</small></strong><div class="stat-foot">Reviewed by a specialist, accepted by you</div></div></div>${
    c.waiting.length
      ? `<section class="section"><div class="section-title"><h2>Your attention, please <span class="count-chip">${c.waiting.length}</span></h2><span>Make a decision. Keep things moving.</span></div><div class="decision-grid">${c.waiting
          .slice(0, 4)
          .map(
            (t) =>
              `<button class="decision-card" data-action="open-task" data-id="${t.id}"><span class="decision-icon">${icon(t.status === 'awaiting_plan' ? 'git' : 'eye')}</span><span class="decision-copy"><small>${e(statusNames[t.status])}${t.demo ? ' · Demo' : ''}</small><strong>${e(t.title)}</strong><span>${e(t.latestSummary || t.error || 'Your input is needed.')}</span></span>${icon('arrow')}</button>`,
          )
          .join('')}</div></section>`
      : ''
  }<section class="section"><div class="section-title"><h2>Recent work <span class="count-chip">${state.tasks.length}</span></h2>${button('navigate', 'View all tasks', 'text', 'arrow', 'data-view="tasks"')}</div>${state.tasks.length ? taskTable(state.tasks.slice(0, 8)) : `<div class="welcome-card"><div class="welcome-art"><span class="orbit-label left">${harnessBadge('codex')} Codex</span><span class="orbit-center">${icon('relay')}</span><span class="orbit-label right">${harnessBadge('claude')} Claude</span><span class="orbit-label bottom">${harnessBadge('pi')} Pi</span></div><h2>Your next task has a whole team behind it.</h2><p>Investigation, thoughtful design, implementation, and an independent<br> review — connected by one clear thread.</p><div class="welcome-actions">${button('new-task', 'Create your first task', 'primary', 'plus')}${button('demo', 'Explore a demo', 'secondary', 'arrow')}</div><small>You approve the approach. You have the final say.</small></div>`}</section><div class="how-it-works"><div><span class="eyebrow">A WORKFLOW THAT THINKS AHEAD</span><h3>Hands-free work.<br>Human-led decisions.</h3></div><div class="flow-mini">${['Investigate', 'Design', 'You approve', 'Build & verify', 'Review', 'You accept'].map((s, i) => `${i ? icon('chevron') : ''}<span class="${s.startsWith('You') ? 'human' : ''}">${s}</span>`).join('')}</div></div>`;
}
function taskTable(tasks) {
  return `<div class="task-table"><div class="table-header"><span>Task</span><span>Status</span><span>Specialists</span><span>Updated</span><span></span></div>${tasks.map((t) => `<button class="task-row" data-action="open-task" data-id="${t.id}"><span class="task-name"><span class="task-symbol">${icon('layers')}</span><span><strong>${e(t.title)} ${t.demo ? '<em class="demo-label">DEMO</em>' : ''}</strong><small>${e((t.repositories?.length ? t.repositories.map((r) => r.repository.name) : [t.repository.name]).join(' + '))} <span>·</span> ${e(stageNames[t.stage] || 'Ready')}</small></span></span><span>${badge(displayStatus(t))}</span><span class="avatar-stack">${[...new Set(Object.values(t.routing).filter((h) => h !== 'checks'))].map((h) => harnessBadge(h)).join('')}</span><span class="muted">${ago(t.updatedAt)}</span>${icon('chevron')}</button>`).join('')}</div>`;
}
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
  return `<div class="task-heading"><button class="back-link" data-action="navigate" data-view="tasks">← All tasks</button><div class="task-title-row"><h1>${e(t.title)}</h1>${t.demo ? '<span class="demo-label large">SIMULATED DEMO</span>' : ''}</div><div class="task-subtitle"><button class="status-editor" data-action="edit-status" aria-label="Change task status" title="${t.statusOverride ? 'Manual status override' : 'Change task status'}">${badge(displayStatus(t))}${icon('chevron')}</button><span>${e((t.repositories?.length ? t.repositories.map((r) => r.repository.name) : [t.repository.name]).join(' + '))}</span><span>·</span><span>${t.id.slice(0, 8)}</span>${t.ticket ? `<span>·</span>${issueLink(t.ticket)}` : ''}<span>·</span><span>Created ${ago(t.createdAt).toLowerCase()}</span></div>${liveProgress(t, state.events)}<div class="task-controls">${!['completed', 'cancelled'].includes(t.status) ? button('configure-task', ['running', 'queued', 'manual'].includes(t.status) ? 'Pause & configure' : 'Configure task', 'secondary', 'settings') : ''}${button('duplicate-task', 'Duplicate task', 'text small', 'plus')}${t.status === 'draft' ? button('task-action', 'Start workflow', 'primary', 'bolt', 'data-operation="start"') : ''}${['blocked', 'interrupted', 'paused'].includes(t.status) && !(t.status === 'blocked' && t.blockerDecision) ? button('task-action', 'Resume workflow', 'primary', 'arrow', 'data-operation="resume"') : ''}${t.status === 'manual' ? button('task-action', 'Return to automation', 'primary', 'arrow', 'data-operation="return-control"') : ''}${live ? button('task-action', 'Pause', 'secondary small', 'pause', 'data-operation="pause"') : ''}${!['completed', 'cancelled'].includes(t.status) ? button('confirm-cancel', 'Cancel', 'text small') : ''}<a class="btn text small" href="/api/tasks/${t.id}/export" download>${icon('download')}Export</a></div></div>${t.demo ? '<div class="demo-banner">' + icon('spark') + 'Demo mode. Harness responses and checks are simulated; no repository files are changed.</div>' : ''}<div class="task-layout"><div class="task-center">${t.status === 'blocked' && t.blockerDecision ? '' : taskSummary(t, state.events)}${state.executionMapOpen ? executionMap(t, { selectedId: state.graphSelectedId, zoom: state.graphZoom }) : ''}${t.error && !(t.status === 'blocked' && t.blockerDecision) ? `<details class="error-panel" data-event-key="blocker"><summary>Blocker details</summary><p>${e(t.error)}</p></details>` : ''}${blockerDecisionView(t)}${t.status === 'awaiting_plan' ? planGate(t) : ''}${t.status === 'awaiting_final' ? `<div class="approval-panel final-panel"><div class="approval-icon">${icon('check')}</div><div><span class="eyebrow">YOUR FINAL LOOK</span><h2>The specialists are done. Over to you.</h2><p>Verification passed and independent review is complete. Inspect the handoffs and diff before accepting. Acceptance does not commit or publish; those steps follow below.</p><div class="approval-actions">${button('task-action', 'Accept result', 'primary', 'check', 'data-operation="accept"')}${button('request-changes', 'Request changes', 'secondary')}</div></div></div>` : ''}${publicationPanel(t)}<div class="detail-tabs" role="tablist">${[
    ['overview', 'Overview'],
    ['thread', 'Activity thread'],
    ['terminals', 'Live terminals'],
    ['handoffs', 'Handoffs'],
    ['diff', 'Code changes'],
    ['transcript', 'Execution log'],
  ]
    .map(
      ([id, name]) =>
        `<button role="tab" aria-selected="${state.tab === id}" class="${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${name}${id === 'handoffs' ? `<span>${t.attempts.filter((a) => a.handoff).length}</span>` : ''}</button>`,
    )
    .join(
      '',
    )}</div><div class="detail-content">${state.tab === 'overview' ? taskDetails(t) || empty('book', 'No description yet', 'Configure this task to add requirements.') : state.tab === 'terminals' ? terminalView(t, state) : state.tab === 'thread' ? threadView(t) : state.tab === 'handoffs' ? handoffsView(t) : state.tab === 'diff' ? diffView(t) : transcriptView(t)}</div>${!['completed', 'cancelled'].includes(t.status) ? `<form id="message-form" class="message-box">${markdownEditor({ id: 'task-message', name: 'message', label: 'Add direction or context', rows: 3, max: 20000 })}<div><small>${t.canSteer ? 'Steer sends direction to the active session; Claude interrupts and resumes.' : 'Context stays pending until an agent receives it.'} ${t.messages.filter((m) => m.delivery === 'pending').length} pending.</small>${t.canSteer ? '<label><input id="steer-active" type="checkbox" name="steer" checked> Steer active agent</label>' : ''}<button class="btn secondary small" type="submit">Send direction ${icon('arrow')}</button></div></form>` : ''}</div><aside class="task-context">${sideChat(t, state.sideChatOpen)}${state.memoryAvailable ? runMemories(t) : ''}<section class="context-card"><div class="context-title">WORKFLOW <span class="live-label ${live ? 'is-live' : ''}">${live ? '● LIVE' : t.demo ? '6 STAGES' : '7 STAGES'}</span></div><ol class="stage-list">${workflowStages(t)}${deliveryWorkflowStages(t)}</ol><button class="btn secondary workflow-graph-button" data-action="open-execution-map" aria-label="Open execution graph">Execution graph ↗</button></section>${(t
    .repositories?.length > 1
    ? t.repositories
    : [t]
  )
    .map(
      (r) =>
        `<section class="context-card"><div class="context-title">WORKSPACE ${icon('git')}</div><strong class="workspace-name">${e(r.repository.name)}</strong><details class="workspace-details" data-event-key="workspace-${e(r.repository.id)}"><summary>Branch, directory &amp; setup</summary><dl><dt>Repository</dt><dd>${e(r.repository.name)}</dd><dt>Prerequisites</dt><dd>${e(
          (t.dependencies ?? [])
            .filter((d) => d.repositoryId === r.repository.id)
            .map(
              (d) =>
                (t.repositories ?? [t]).find((x) => x.repository.id === d.dependsOn)?.repository
                  .name ?? d.dependsOn,
            )
            .join(', ') || 'Independent',
        )}</dd><dt>Workspace mode</dt><dd>${r.repository.strategy === 'attach' ? 'Attach existing checkout (explicit opt-in)' : r.repository.strategy === 'managed' ? 'New managed worktree per task' : 'New isolated worktree per task'}</dd><dt>Branch</dt><dd class="mono wrap">${e(r.branch || 'Assigned when started')}</dd><dt>Directory</dt><dd class="mono wrap">${e(r.workspace || 'Created when started')}</dd></dl></details></section>`,
    )
    .join(
      '',
    )}${t.chosenApproach ? `<section class="context-card approved-card"><div class="context-title">APPROVED APPROACH ${icon('check')}</div><strong>${e(t.chosenApproach.title)}</strong><p>${e(t.chosenApproach.description)}</p></section>` : ''}<div class="context-foot">${icon('eye')}You approve the approach.<br>You accept the final result.</div></aside></div>`;
}
function planGate(t) {
  const plan = t.attempts.findLast((a) => a.stage === 'plan' && a.handoff)?.handoff;
  return `<div class="approval-panel"><div class="gate-heading"><div class="approval-icon">${icon('git')}</div><div><span class="eyebrow">A DECISION FOR YOU</span><h2>Choose the way forward.</h2><p>The investigation is complete. Review the approaches before implementation starts.</p></div></div><form id="approve-form"><div class="approach-options">${(plan?.options ?? []).map((o, i) => `<label class="approach-option"><input type="radio" name="optionId" value="${e(o.id)}" ${i === 0 ? 'checked' : ''}><span><strong>${e(o.title)}${i === 0 ? '<em>Recommended</em>' : ''}</strong><span>${e(o.description)}</span><small>${e(o.tradeoffs)}</small></span></label>`).join('')}</div><label class="field-label" for="approval-note">Any additional direction? <span>Optional</span></label><input id="approval-note" class="input" placeholder="Constraints, preferences, things to keep in mind…" maxlength="10000"><div class="approval-actions"><button class="btn primary" type="submit">Approve & implement ${icon('arrow')}</button>${button('request-changes', 'Revise the proposal', 'text')}</div></form></div>`;
}
function threadView(t) {
  const meaningful = new Set([
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
  return `<div class="activity-browser">${activityRunNavigation(t, run.selected, state.activitySelection)}<div class="activity-run-content">${activityRunHeader(run.selected, state.events)}<div class="timeline">${run.events.map((ev) => `<article data-event-seq="${ev.seq}" class="timeline-item ${ev.type === 'decision' ? 'decision-event' : ''}"><div class="timeline-avatar">${activityEventIdentity(ev).harness ? harnessBadge(activityEventIdentity(ev).harness) : icon(ev.type === 'approval' || ev.type === 'accepted' ? 'check' : ev.type === 'decision' ? 'eye' : ev.type === 'feedback' ? 'arrow' : 'layers')}</div><div class="timeline-body"><div class="event-meta">${activityEventMeta(ev, ev.stage ? (stageNames[ev.stage] ?? (ev.stage === 'publish' ? 'Publication' : 'PR status')) : null)}<time>${ago(ev.at)}</time>${ev.repositoryId ? `<span>${e((t.repositories?.length > 1 ? t.repositories : [t]).find((r) => r.repository.id === ev.repositoryId)?.repository.name ?? ev.repositoryId)}</span>` : ''}</div>${ev.toolEvents ? `<details class="event-details tool-activity" data-event-key="tools-${ev.seq}"><summary>${ev.toolEvents.length} ${ev.toolEvents.length === 1 ? 'activity' : 'activities'} · ${e(concise(ev.toolEvents.at(-1).summary, 120))}</summary>${ev.toolEvents.map((tool) => `<div class="tool-entry"><strong>${e(concise(tool.summary, 180))}</strong>${tool.details ? `<pre class="code-block">${e(tool.details)}</pre>` : ''}</div>`).join('')}</details>` : ev.type === 'activity' && ev.kind === 'message' ? `<div class="prose agent-message">${prose(concise(ev.details || ev.summary, 360))}</div>${(ev.details || ev.summary).length > 360 ? `<details class="event-details" data-event-key="message-${ev.seq}"><summary>Full message</summary><div class="prose">${prose(ev.details || ev.summary)}</div></details>` : ''}` : `<h3>${e(concise(ev.summary))}</h3>`}${ev.type === 'handoff' ? `<details class="report-section" data-event-key="handoff-report-${ev.seq}"><summary>Run details &amp; evidence</summary>${handoffBodyForThread(t, ev)}</details>` : ev.details && !ev.toolEvents && ev.type !== 'activity' ? `<details data-event-key="event-${ev.seq}" class="event-details"><summary>Details</summary><div class="prose">${prose(ev.details)}</div></details>` : ''}</div></article>`).join('')}${followingCurrent && ['running', 'queued'].includes(t.status) ? `<article class="timeline-item working"><div class="timeline-avatar">${harnessBadge(latestAttempt?.harness ?? t.routing[t.stage])}</div><div class="timeline-body"><div class="event-meta"><strong>${e(stageNames[t.stage])}</strong><span class="typing-dots"><i></i><i></i><i></i></span></div><p>${e(concise(activity?.summary || 'Preparing the next handoff…'))}</p><small>Updates appear here as work progresses.</small></div></article>` : ''}</div></div></div>`;
}
function handoffBodyForThread(t, ev) {
  return handoffBody(t.attempts.find((a) => a.id === ev.attemptId)?.handoff);
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
  if (d.error) return `<div class="error-panel">${e(d.error)}</div>`;
  const repositoryId = d.repositoryId ?? t.repository.id;
  const comments = (t.reviewComments || []).filter((c) => c.repositoryId === repositoryId);
  const files = diffFileGroups(d);
  return `<div class="panel-heading"><div><h2>Code changes</h2><p>${files.length} ${files.length === 1 ? 'file' : 'files'} · compared with <code>${e(t.baseCommit?.slice(0, 10))}</code></p></div>${button('refresh-diff', 'Refresh', 'secondary small')}</div>${canComment ? '<div class="review-callout"><strong>Ready for your review</strong><p>Open a file and use + beside a line to leave feedback. Send open comments for a focused repair.</p></div>' : ''}<div class="diff-file-toolbar"><span>Browse files</span><button class="btn text small" data-action="expand-diff">Expand all</button><button class="btn text small" data-action="collapse-diff">Collapse all</button></div>${files.map((file, fileIndex) => `<details class="diff-file" data-event-key="diff-${e(repositoryId)}-${e(file.name)}" ${fileIndex === 0 ? 'open' : ''}><summary><span class="diff-file-name"><strong>${e(file.name.split('/').at(-1))}</strong><small>${e(file.name)}</small></span><span class="diff-count"><b>+${file.additions}</b><span>−${file.deletions}</span></span></summary><pre class="diff-code">${file.lines.map((line) => `<span class="diff-line ${line.kind} ${line.anchor ? 'has-anchor' : ''}">${canComment && line.anchor ? `<button class="diff-comment-button" data-action="comment-line" data-repository-id="${e(repositoryId)}" data-line="${line.index}" aria-label="Comment on ${e(line.anchor.path)} line ${line.anchor.line}">+</button>` : ''}${line.anchor ? `<small class="diff-line-number">${line.anchor.side === 'old' ? 'old' : 'new'} ${line.anchor.line}</small>` : ''}${e(line.text)}</span>`).join('\n')}</pre></details>`).join('')}${d.stat ? `<details class="report-section"><summary>Change statistics</summary><pre class="diff-stat">${e(d.stat)}</pre></details>` : ''}${comments.length ? `<section class="context-card"><h3>Inline feedback</h3>${comments.map((c) => `<article class="review-comment"><strong>${e(c.anchor.path)}:${c.anchor.line} · ${e(c.status)}${c.fingerprint !== d.fingerprint ? ' · Earlier workspace' : ''}</strong><div class="prose">${prose(c.text)}</div>${canComment && c.status !== 'resolved' ? button('resolve-comment', 'Mark resolved', 'text small', '', `data-comment-id="${e(c.id)}"`) : ''}</article>`).join('')}${canComment && comments.some((c) => c.status === 'open') ? button('focused-repair', 'Send all open comments for repair', 'primary small') : ''}</section>` : ''}${!d.text && !d.untracked.length ? empty('check', 'No changes yet', 'Changes appear here as the workspace changes.') : ''}`;
}
function transcriptView(t) {
  return executionLogs(t, state.events, {
    run: state.logRun,
    stream: state.logStream,
    query: state.logQuery,
  });
}
function repositoriesView() {
  return `${pageHeading('ONE TASK, CONNECTED REPOSITORIES', 'Repositories', 'Bring your own codebase. Keep its conventions and tooling.', button('add-repository', 'Add repository', 'primary', 'plus'))}<div class="repository-grid">${state.config.repositories.map((r) => `<article class="repository-card"><div class="repo-top"><span class="repo-icon">${icon('folder')}</span>${button('edit-repository', 'Edit profile', 'text small', '', `data-id="${e(r.id)}"`)}</div><h2>${e(r.name)}</h2><p class="mono wrap">${e(r.path)}</p><div class="repo-tags"><span>${icon('git')}${r.strategy === 'attach' ? 'Attach existing checkout' : r.strategy === 'managed' ? 'Managed task worktrees' : 'Isolated worktrees'}</span><span>${icon('check')}${r.checks.length} verification ${r.checks.length === 1 ? 'command' : 'commands'}</span></div><div class="repo-footer"><small>Working directory <code>${e(r.cwd)}</code></small><span class="configured-dot">Agent publication</span></div></article>`).join('')}${!state.config.repositories.length ? empty('folder', 'Connect your first repository', 'Add a checkout and its verification commands to start real work.', button('add-repository', 'Add repository', 'primary', 'plus')) : ''}</div><div class="info-panel">${icon('git')}<div><strong>Your repository stays yours.</strong><p>Every specialist uses the same task workspace. Relay preserves changes and worktrees when a task finishes. Repository-specific policies and private integrations stay in your ignored local configuration.</p></div></div>`;
}
function harnessesView() {
  return `${pageHeading('THE RIGHT SPECIALIST, EACH STEP', 'Harnesses', 'Use your existing CLI accounts. Choose models and route work your way.')}<form id="harness-form"><div class="harness-grid">${[
    'codex',
    'claude',
    'pi',
  ]
    .map((id) => {
      const h = state.config.harnesses[id];
      const available = state.harnesses.find((v) => v.id === id)?.available;
      return `<article class="harness-card"><div class="harness-card-heading">${harnessBadge(id)}<div><h2>${id === 'pi' ? 'Pi' : id === 'codex' ? 'Codex' : 'Claude Code'}</h2><small>${id === 'codex' ? 'Investigate. Implement. Iterate.' : id === 'claude' ? 'Design. Challenge. Review.' : 'Triage. Route. Adapt.'}</small></div></div><div class="availability ${available ? 'available' : ''}"><span class="status-dot"></span>${available ? 'Executable available' : 'Executable not found'}<small>Authentication checked when run</small></div><label class="field-label" for="${id}-command">Executable</label><input class="input mono" id="${id}-command" name="${id}-command" value="${e(h.command)}" required><label class="field-label" for="${id}-model">Model override <span>Optional</span></label><input class="input" id="${id}-model" name="${id}-model" placeholder="Use harness default" value="${e(h.model)}"><label class="toggle-label"><input type="checkbox" name="${id}-enabled" ${h.enabled ? 'checked' : ''}> Enabled for routing</label></article>`;
    })
    .join(
      '',
    )}</div><section class="routing-panel"><div><h2>Specialist routing</h2><p>Defaults for new tasks. Each task keeps its own routing.</p></div><div class="routing-grid">${Object.entries(
    state.config.routing,
  )
    .map(
      ([stage, id]) =>
        `<label>${e(stageNames[stage])}<select class="input" name="route-${stage}">${['codex', 'claude', 'pi'].map((h) => `<option value="${h}" ${id === h ? 'selected' : ''}>${h === 'pi' ? 'Pi' : h === 'codex' ? 'Codex' : 'Claude'}</option>`).join('')}</select></label>`,
    )
    .join(
      '',
    )}</div></section><div class="form-footer"><span>Model IDs and permissions follow your installed harness configuration.</span><button class="btn primary" type="submit">Save harness configuration ${icon('check')}</button></div></form>${outcomesView(state.outcomes, state.config, state.outcomesRepository)}`;
}
function settingsView() {
  return `${pageHeading('MAKE IT YOURS', 'Settings', 'Local configuration, execution limits, and private integration profiles.')}${storageView(state.storage)}<form id="settings-form" class="settings-panel"><h2>Execution</h2><p>Quality-first workflows, with explicit limits on runaway retries.</p><div class="settings-fields"><label>Concurrent tasks<input id="setting-concurrency" class="input" type="number" name="concurrency" min="1" max="8" value="${state.config.concurrency}" required><small>Work in different repositories concurrently.</small></label><label>Automatic repair rounds<input id="setting-rounds" class="input" type="number" name="maxRepairRounds" min="1" max="10" value="${state.config.maxRepairRounds}" required><small>Pause for your input after repeated failures.</small></label><label>Blocker recovery attempts<input class="input" type="number" name="maxRecoveryAttempts" min="0" max="5" value="${state.config.maxRecoveryAttempts ?? 2}" required><small>Agents try to resolve blockers before asking you.</small></label><label>Stage budget (minutes)<input id="setting-timeout" class="input" type="number" name="timeoutMinutes" min="1" max="240" value="${state.config.timeoutMinutes}" required><small>Progress can extend each agent or check up to twice this budget.</small></label></div><button class="btn primary" type="submit">Save execution settings</button></form><section class="settings-panel"><h2>Private integration profiles</h2><p>Import a repository profile or complete configuration as JSON. Private hostnames, paths, instructions, and provider commands stay in ignored local state.</p><div class="inline-actions">${button('import-profile', 'Import local profile', 'secondary', 'download')}${button('view-config', 'View configuration', 'text', 'code')}</div></section><section class="settings-panel"><h2>Local by design</h2><p>Relay listens on <code>127.0.0.1</code>. Task history, transcripts, and approvals are stored on this machine. Your harness CLIs handle authentication; Relay does not store API keys.</p><p>Harness and verification commands run with your user account. Use an isolated environment for untrusted code. Read the project README for execution and recovery details.</p></section>`;
}

function showModal(title, contents, wide = false) {
  modalReturnFocus = document.activeElement;
  document.querySelector('#modal-root').innerHTML =
    `<dialog id="dialog" class="modal ${wide ? 'wide' : ''}"><div class="modal-heading"><h2>${title}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>${contents}</dialog>`;
  const dialog = document.querySelector('#dialog');
  prepareSearchSelects(dialog);
  dialog.showModal();
  dialog.addEventListener('close', () => {
    if (state.modal?.restoreId) {
      const previewId = state.modal.restoreId;
      state.modal.restoreId = null;
      api('/backups/discard', 'POST', { previewId }).catch(() => {});
    }
    document.querySelector('#modal-root').innerHTML = '';
    modalReturnFocus?.focus();
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
        dialog.close();
    }
  });
}
function closeModal() {
  document.querySelector('#dialog')?.close();
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
function repositoryModal(id) {
  const r = state.config.repositories.find((r) => r.id === id) || {
    name: '',
    path: '',
    cwd: '.',
    strategy: 'worktree',
    checks: [],
    setup: [],
    instructions: '',
  };
  state.modal = { repositoryId: id };
  showModal(
    id ? 'Edit repository profile' : 'Connect a repository',
    `<form id="repository-form"><div class="form-columns"><label>Name<input class="input" name="name" value="${e(r.name)}" placeholder="My service" maxlength="100" required></label><label>Workspace strategy<select class="input" name="strategy"><option value="worktree" ${r.strategy === 'worktree' ? 'selected' : ''}>New worktree per task</option><option value="managed" ${r.strategy === 'managed' ? 'selected' : ''}>Managed worktree per task</option><option value="attach" ${r.strategy === 'attach' ? 'selected' : ''}>Attach existing checkout</option></select></label></div><label class="field-label" for="repo-path">Absolute checkout path</label><input class="input mono" id="repo-path" name="path" value="${e(r.path)}" placeholder="/absolute/path/to/repository" required><label class="field-label" for="repo-cwd">Working subdirectory</label><input class="input mono" id="repo-cwd" name="cwd" value="${e(r.cwd)}" placeholder="."><label class="field-label" for="repo-verification">Verification</label><select class="input" id="repo-verification" name="verificationMode"><option value="agent" ${r.verificationMode !== 'commands' ? 'selected' : ''}>Agent discovers and runs checks</option><option value="commands" ${r.verificationMode === 'commands' ? 'selected' : ''}>Run configured commands</option></select><label class="field-label" for="repo-checks">Verification commands <span>One JSON argument array per line</span></label><textarea class="input mono" id="repo-checks" name="checks" rows="3" placeholder='["npm","test"]\n["npm","run","lint"]'>${e(commandsInput(r.checks))}</textarea><p class="form-help">Used only in configured-command mode. Agent verification discovers checks from repository guidance and runs them with host access.</p><details class="advanced-fields"><summary>Setup, provider integration & instructions</summary><label class="field-label" for="repo-workspace-command">Managed workspace creation command <span>JSON argument array</span></label><textarea class="input mono" id="repo-workspace-command" name="workspaceCommand" rows="2">${e(r.workspaceCommand ? commandsInput([r.workspaceCommand]) : '')}</textarea><label class="field-label" for="repo-workspace-path">Managed checkout root template</label><input class="input mono" id="repo-workspace-path" name="workspacePath" value="${e(r.workspacePath || '')}" placeholder="/absolute/workspaces/{workspaceName}"><p class="form-help">For managed worktrees only. Placeholders: {workspaceName}, {branch}, {baseCommit}, {taskId}. The trusted command must be idempotent and create a clean checkout at the requested base and branch.</p><fieldset class="task-editor-section"><legend>Agent development access</legend><label class="checkbox-row"><input type="checkbox" name="analysisCommands" ${r.developmentAccess?.analysisCommands ? 'checked' : ''}> Allow development commands during investigation and review</label><p class="form-help">Allows writes to ignored build artifacts in the task workspace. Source changes still block analysis and require your approved approach.</p><label class="checkbox-row"><input type="checkbox" name="networkAccess" ${r.developmentAccess?.networkAccess ? 'checked' : ''}> Allow network access for sandboxed development commands</label><label class="field-label" for="repo-writable-roots">Additional writable runtime directories <span>Absolute paths, one per line</span></label><textarea class="input mono" id="repo-writable-roots" name="writableRoots" rows="2">${e((r.developmentAccess?.writableRoots ?? []).join('\n'))}</textarea><p class="form-help">Codex uses these for development logs and caches. Permissions are fixed when the task is created; agents cannot expand them.</p></fieldset><label class="field-label" for="repo-setup">Setup commands <span>Run once per task workspace</span></label><textarea class="input mono" id="repo-setup" name="setup" rows="2" placeholder='["npm","ci"]'>${e(commandsInput(r.setup))}</textarea><label class="field-label" for="repo-issue">Issue import command</label><textarea class="input mono" id="repo-issue" name="issueCommand" rows="2" placeholder='["gh","issue","view","{ticket}","--json","title,body,url,author,comments,labels,assignees,state,createdAt,updatedAt"]'>${e(r.issueCommand ? commandsInput([r.issueCommand]) : '')}</textarea><label class="field-label" for="repo-pr">Publication command hint <span>Optional · agent discovers tooling</span></label><textarea class="input mono" id="repo-pr" name="prCommand" rows="2" placeholder='["gh","pr","create","--draft","--fill"]'>${e(r.prCommand ? commandsInput([r.prCommand]) : '')}</textarea><label class="field-label" for="repo-instructions">Additional workflow instructions</label><textarea class="input" id="repo-instructions" name="instructions" rows="4" placeholder="Private repository policies, skill references, required practices…">${e(r.instructions)}</textarea></details><div class="modal-footer">${id ? button('delete-repository', 'Remove profile', 'danger text', '', `data-id="${e(id)}"`) : '<span></span>'}<div>${button('close-modal', 'Cancel', 'text')}<button class="btn primary" type="submit">Save repository ${icon('check')}</button></div></div></form>`,
    true,
  );
}
let refreshInFlight, refreshAgain;
function refresh() {
  // Serialize snapshots, but retain a trailing refresh after navigation or new events.
  if (refreshInFlight) {
    refreshAgain = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    do {
      refreshAgain = false;
      await refreshSnapshot();
    } while (refreshAgain);
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
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
  if (state.view === 'harnesses')
    state.outcomes = await api(
      `/outcomes?repositoryId=${encodeURIComponent(state.outcomesRepository)}`,
    );
  if (state.selected) {
    const selected = state.selected;
    const task = await api(`/tasks/${selected}`);
    let events = state.task?.id === selected ? state.events : [];
    let more;
    do {
      more = await api(`/tasks/${selected}/events?after=${events.at(-1)?.seq || 0}`);
      events = events.concat(more);
    } while (more.length === 1000);
    if (state.selected === selected) {
      state.task = pendingStatuses.apply(task);
      state.events = events;
      await refreshTerminal(task);
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
async function openTask(id, recordHistory = true, tab = 'overview') {
  if (state.selected !== id) {
    state.sideChatOpen = false;
    state.executionMapOpen = false;
    state.graphSelectedId = null;
  }
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
  await refresh();
  if (recordHistory) history.pushState(null, '', taskRoute(id, tab));
  if (tab === 'diff') await loadDiff();
}
async function navigate(view, recordHistory = true) {
  state.view = view;
  state.selected = null;
  state.task = null;
  shell();
  if (recordHistory) history.pushState(null, '', `#${view}`);
  if (view === 'harnesses') {
    state.harnesses = await api('/harnesses');
    renderMain();
  }
}
async function saveConfig(config) {
  state.config = await api('/config', 'PUT', config);
  state.harnesses = await api('/harnesses');
}
async function loadDiff() {
  state.diff = null;
  renderMain();
  try {
    state.diff = await api(`/tasks/${state.selected}/diff`);
  } catch (error) {
    state.diff = { error: error.message };
  }
  renderMain();
}

document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  event.preventDefault();
  if (state.busy) return;
  const action = element.dataset.action;
  try {
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
    if (action === 'delivery-run') {
      state.tab = 'thread';
      state.activityTaskId = state.selected;
      state.activitySelection = element.dataset.id || 'latest';
      history.pushState(null, '', taskRoute(state.selected, 'thread'));
      renderMain();
      return;
    }
    if (action === 'delivery-details') {
      showModal(
        'Delivery details',
        publicationDetails(state.task, element.dataset.repositoryId),
        true,
      );
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
        `<p>${e(memory.title)}</p><p>Future runs will no longer use this memory. Historical run snapshots remain in task history.</p><div class="modal-footer"><button class="btn secondary" data-action="close-modal">Keep memory</button><button class="btn primary" data-action="confirm-delete-memory">Delete memory</button></div>`,
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
    if (action === 'activity-run') {
      state.activitySelection = element.dataset.run;
      renderMain();
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
        `<p>${e(entry.title)} · ${e(entry.repository)}</p><p class="wrap mono">${e(entry.path)}</p><p>${bytes(entry.bytes)}. Relay will recheck cleanliness and commit preservation. The Git branch, task, approvals and artifacts are retained.</p><div class="modal-footer"><button class="btn secondary" data-action="close-modal">Keep worktree</button><button class="btn primary" data-action="confirm-cleanup">Remove clean worktree</button></div>`,
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
      renderMain();
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
      history.replaceState(null, '', taskRoute(state.selected, state.tab));
      await refresh();
      return;
    }
    if (action === 'takeover') {
      showModal(
        'Take control of this workspace',
        `<p class="modal-description">Relay will stop the active agent, then open a shell in this task’s worktree. Use the interactive terminal directly in the Live terminals tab. You can also run your preferred harness there. Return control when ready; Relay will rerun ${state.task.chosenApproach ? 'all checks and independent review' : 'investigation and approach approval'}.</p><p class="modal-description">Closing the browser tab keeps manual control. Returning to automation closes the terminal and its processes.</p><div class="modal-footer">${button('close-modal', 'Keep automation', 'text')}${button('takeover-confirm', 'Take control', 'primary', 'code', `data-repository-id="${e(element.dataset.repositoryId)}"`)}</div>`,
      );
      return;
    }
    if (action === 'takeover-confirm') {
      await api(`/tasks/${state.selected}/takeover`, 'POST', {
        repositoryId: element.dataset.repositoryId,
      });
      closeModal();
      state.tab = 'terminals';
      history.replaceState(null, '', taskRoute(state.selected, state.tab));
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
      focusBoard();
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
      state.sideChatOpen = action === 'open-side-chat';
      renderMain();
      if (state.sideChatOpen) document.querySelector('#side-question')?.focus();
      return;
    }
    if (['open-execution-map', 'close-execution-map'].includes(action)) {
      state.executionMapOpen = action === 'open-execution-map';
      renderMain();
      if (state.executionMapOpen)
        document
          .querySelector('.graph-node.selected')
          ?.scrollIntoView({ block: 'nearest', inline: 'center' });
      return;
    }
    if (action === 'graph-current') {
      state.graphSelectedId = null;
      renderMain();
      document
        .querySelector('.graph-node.selected')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
      return;
    }
    if (action === 'graph-open-activity') {
      state.activityTaskId = state.task.id;
      state.activitySelection = element.dataset.id;
      state.executionMapOpen = false;
      state.tab = 'thread';
      history.pushState(null, '', taskRoute(state.selected, state.tab));
      renderMain();
      return;
    }
    if (action === 'graph-select') {
      state.graphSelectedId = element.dataset.id;
      renderMain();
      return;
    }
    if (['graph-zoom-in', 'graph-zoom-out', 'graph-reset'].includes(action)) {
      state.graphZoom =
        action === 'graph-reset'
          ? 1
          : Math.max(
              0.5,
              Math.min(1.5, state.graphZoom + (action === 'graph-zoom-in' ? 0.1 : -0.1)),
            );
      renderMain();
      return;
    }
    if (action === 'tab') {
      state.tab = element.dataset.tab;
      if (state.tab === 'transcript' && element.dataset.runId) state.logRun = element.dataset.runId;
      history.pushState(null, '', taskRoute(state.selected, state.tab));
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
        note: 'Address these focused inline review requests. Keep unrelated code unchanged; rerun all checks and review.',
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
    if (action === 'confirm-cancel')
      return showModal(
        'Cancel this task?',
        `<p class="modal-description">Execution will stop. The branch, workspace, and existing changes will be kept for you to inspect.</p><div class="modal-footer">${button('close-modal', 'Keep working', 'text')}${button('task-action', 'Cancel task', 'danger', 'stop', 'data-operation="cancel"')}</div>`,
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
        history.replaceState(null, '', taskRoute(state.selected, state.tab));
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
      toast('Publication agent started. Follow its progress in Delivery.');
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
        `<p>${preview.tasks} tasks · ${preview.events} events · ${preview.files} files</p><p>${e(preview.external)}</p><p>This replaces current Relay history, profiles and assets. A safety archive is created first. Existing repository checkouts stay in place; unfinished workflows require inspection and explicit resume.</p><details><summary>Repository paths and configured commands</summary><pre class="code-block">${e(JSON.stringify(preview.repositories, null, 2))}</pre></details><div class="modal-footer"><button class="btn secondary" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-restore">Restore this backup</button></div>`,
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
        developmentAccess: {
          analysisCommands: values.analysisCommands === 'on',
          networkAccess: values.networkAccess === 'on',
          writableRoots: (values.writableRoots ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        },
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
      toast('Repository profile saved.');
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
      toast('Harness configuration saved.');
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
  if (event.key === 'Escape' && (state.sideChatOpen || state.executionMapOpen)) {
    state.sideChatOpen = false;
    state.executionMapOpen = false;
    renderMain();
  }
});
window.addEventListener('popstate', () => {
  const hash = location.hash.slice(1);
  const operation = hash.startsWith('task/')
    ? openTask(parseTaskRoute(hash)?.id ?? hash.slice(5), false, parseTaskRoute(hash)?.tab)
    : navigate(
        ['tasks', 'inbox', 'repositories', 'harnesses', 'settings', 'memory'].includes(hash)
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
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch((error) => toast(error.message, true)), 150);
  };
}
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
    const hash = location.hash.slice(1);
    if (hash.startsWith('task/'))
      await openTask(parseTaskRoute(hash)?.id ?? hash.slice(5), false, parseTaskRoute(hash)?.tab);
    else {
      state.view = [
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
      shell();
    }
    state.inbox = await api('/inbox');
    if (state.view === 'harnesses') {
      state.outcomes = await api('/outcomes');
      renderMain();
    }
    if (state.view === 'inbox') renderMain();
    state.tasks = state.tasks.map((task) => pendingStatuses.apply(task));
    notifyInbox(state.inbox);
    connect();
    setInterval(() => updateTimers(), 1000);
    setInterval(() => {
      if (state.view === 'task' && !state.busy) refresh().catch(() => {});
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
boot();
