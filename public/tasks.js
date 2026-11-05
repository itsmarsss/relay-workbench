import { e, badge, ago, empty, icon } from './ui.js';
import { columns, workflowColumn, nextStep, workflowBoard } from './workflow.js';
const needsInput = new Set([
  'awaiting_plan',
  'awaiting_final',
  'blocked',
  'interrupted',
  'paused',
  'manual',
]);
export function filterTasks(tasks, state) {
  const filtered = tasks.filter((task) => {
    const entries = task.repositories?.length ? task.repositories : [task];
    const scope =
      state.filter === 'all' ||
      (state.filter === 'attention' && needsInput.has(task.status)) ||
      (state.filter === 'active' && ['running', 'queued'].includes(task.status)) ||
      (state.filter === 'backlog' && task.status === 'draft') ||
      (state.filter === 'completed' && task.status === 'completed') ||
      (state.filter === 'cancelled' && task.status === 'cancelled');
    return (
      scope &&
      (!state.repositoryFilter ||
        entries.some((entry) => entry.repository.id === state.repositoryFilter)) &&
      (!state.stageFilter || workflowColumn(task) === state.stageFilter) &&
      `${task.title} ${task.ticket ?? ''} ${entries.map((entry) => entry.repository.name).join(' ')} ${task.latestSummary ?? ''}`
        .toLowerCase()
        .includes(state.search.toLowerCase().trim())
    );
  });
  const rank = (task) =>
    needsInput.has(task.status)
      ? 0
      : ['running', 'queued'].includes(task.status)
        ? 1
        : task.status === 'draft'
          ? 2
          : task.status === 'completed'
            ? 3
            : 4;
  return filtered.sort(
    (a, b) =>
      (state.taskSort === 'title'
        ? a.title.localeCompare(b.title)
        : state.taskSort === 'created'
          ? new Date(b.createdAt) - new Date(a.createdAt)
          : state.taskSort === 'recent'
            ? new Date(b.updatedAt) - new Date(a.updatedAt)
            : rank(a) - rank(b) || new Date(b.updatedAt) - new Date(a.updatedAt)) ||
      a.id.localeCompare(b.id),
  );
}
export function taskList(tasks) {
  return `<div class="task-list" role="list" aria-label="Tasks">${tasks.map((task) => `<article class="task-list-row" role="listitem"><button class="task-list-open" data-action="open-task" data-id="${e(task.id)}"><div class="task-list-copy"><strong>${e(task.title)}${task.demo ? ' <span class="demo-label">DEMO</span>' : ''}</strong><small>${e((task.repositories?.length ? task.repositories : [task]).map((entry) => entry.repository.name).join(' + '))} · ${e(columns.find(([id]) => id === workflowColumn(task))?.[1] ?? '')}${task.ticket ? ` · ${e(task.ticket.match(/\/issues\/(\d+)/)?.[1] ? '#' + task.ticket.match(/\/issues\/(\d+)/)[1] : task.ticket)}` : ''}</small>${task.error || task.latestSummary ? `<p>${e((task.error || task.latestSummary).slice(0, 220))}</p>` : ''}</div><div class="task-list-state">${badge(task.status)}<strong>${e(nextStep(task))}</strong><time>${ago(task.updatedAt)}</time></div>${icon('chevron')}</button></article>`).join('')}</div>`;
}
export function tasksPage(state) {
  const filtered = filterTasks(state.tasks, state);
  const profiles = new Map(state.config.repositories.map((profile) => [profile.id, profile.name]));
  for (const task of state.tasks)
    for (const entry of task.repositories?.length ? task.repositories : [task])
      profiles.set(entry.repository.id, entry.repository.name);
  const scopes = [
    ['all', 'All tasks', state.tasks.length],
    ['attention', 'Needs you', state.tasks.filter((task) => needsInput.has(task.status)).length],
    [
      'active',
      'Running',
      state.tasks.filter((task) => ['running', 'queued'].includes(task.status)).length,
    ],
    ['backlog', 'Backlog', state.tasks.filter((task) => task.status === 'draft').length],
    ['completed', 'Done', state.tasks.filter((task) => task.status === 'completed').length],
    ['cancelled', 'Cancelled', state.tasks.filter((task) => task.status === 'cancelled').length],
  ];
  return `<div class="page-heading"><div><div class="eyebrow">YOUR WORK QUEUE</div><h1>Tasks</h1><p>Pick a task, see its next step, and keep work moving.</p></div></div><nav class="task-scopes" aria-label="Task status filters">${scopes
    .filter(([id, , count]) => id !== 'cancelled' || count)
    .map(
      ([id, label, count]) =>
        `<button data-action="filter" data-filter="${id}" aria-pressed="${state.filter === id}">${label} <span>${count}</span></button>`,
    )
    .join(
      '',
    )}</nav><div class="task-filters"><label class="search-box">${icon('search')}<input id="task-search" placeholder="Search title, repository, or issue…" aria-label="Search tasks" value="${e(state.search)}"></label><label>Repository<select id="task-repository-filter" class="input"><option value="">All repositories</option>${[...profiles].map(([id, name]) => `<option value="${e(id)}" ${state.repositoryFilter === id ? 'selected' : ''}>${e(name)}</option>`).join('')}</select></label><label>Stage<select id="task-stage-filter" class="input"><option value="">All stages</option>${columns.map(([id, name]) => `<option value="${id}" ${state.stageFilter === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label>Sort<select id="task-sort" class="input">${[
    ['priority', 'Next action'],
    ['recent', 'Recently updated'],
    ['created', 'Newest first'],
    ['title', 'Title'],
  ]
    .map(
      ([id, label]) =>
        `<option value="${id}" ${state.taskSort === id ? 'selected' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select></label></div><div class="task-results-toolbar"><p role="status">${filtered.length} of ${state.tasks.length} tasks${state.filter === 'attention' ? ' · awaiting your input' : ''}</p><div>${state.search || state.repositoryFilter || state.stageFilter || state.filter !== 'all' ? '<button class="btn text small" data-action="clear-task-filters">Clear filters</button>' : ''}<div class="segmented layout-switch" aria-label="Task layout">${['list', 'board'].map((layout) => `<button data-action="task-layout" data-layout="${layout}" class="${state.taskLayout === layout ? 'selected' : ''}" aria-pressed="${state.taskLayout === layout}">${layout === 'list' ? 'List' : 'Board'}</button>`).join('')}</div></div></div>${state.taskLayout === 'board' ? `<label class="toggle-label board-empty-toggle"><input type="checkbox" id="show-empty-stages" ${state.showEmptyStages ? 'checked' : ''}>Show empty stages</label>` : ''}${filtered.length ? (state.taskLayout === 'board' ? workflowBoard(filtered, { showEmpty: state.showEmptyStages }) : taskList(filtered)) : empty('layers', 'No tasks here yet', 'Try another filter, clear your search, or create a task.', '<button class="btn secondary" data-action="clear-task-filters">Clear filters</button>')}`;
}
