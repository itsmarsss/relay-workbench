import { currentTaskRun } from './task-runs.js';
import { runLabel } from './run-label.js';
import { displayStatus, followUpRunning } from './task-status.js';
import { e, badge, harnessBadge, stageNames, ago } from './ui.js';

export const columns = [
  ['backlog', 'Backlog', 'Ready when you are'],
  ['discovery', 'Investigation & design', 'Agents gather evidence and propose options'],
  ['approach', 'Approach approval', 'Your decision before coding'],
  ['progress', 'In progress', 'Implementation and verification'],
  ['review', 'In review', 'Independent agent review'],
  ['final', 'Final approval', 'Your final look'],
  ['done', 'Done', 'Accepted results'],
  ['attention', 'Needs attention', 'Blocked, paused, or in your hands'],
  ['cancelled', 'Cancelled', 'Retained for reference'],
];
export function workflowColumn(task) {
  const shown = displayStatus(task);
  if (task.statusOverride || shown !== task.status)
    return (
      {
        draft: 'backlog',
        running: 'progress',
        review: 'review',
        completed: 'done',
        blocked: 'attention',
        cancelled: 'cancelled',
        publishing: 'progress',
      }[shown] ?? 'progress'
    );
  if (task.status === 'draft') return 'backlog';
  if (task.status === 'awaiting_plan') return 'approach';
  if (task.status === 'awaiting_final') return 'final';
  if (task.status === 'completed') return 'done';
  if (task.status === 'cancelled') return 'cancelled';
  if (['manual', 'blocked', 'paused', 'interrupted'].includes(task.status)) return 'attention';
  if (task.stage === 'review') return 'review';
  if (['implement', 'verify'].includes(task.stage)) return 'progress';
  return 'discovery';
}
export function nextStep(task) {
  if (followUpRunning(task)) return 'Follow-up agent running';
  if (displayStatus(task) === 'publishing') return 'Publishing approved changes';
  if (task.statusOverride) return 'Manual status · view task';
  if (task.status === 'completed' && displayStatus(task) === 'blocked')
    return 'Inspect publishing blocker';
  if (task.status === 'draft') return 'Start workflow';
  if (task.status === 'awaiting_plan') return 'Choose an approach';
  if (task.status === 'awaiting_final') return 'Review and accept';
  if (task.status === 'manual') return 'You have control';
  if (['blocked', 'interrupted', 'paused'].includes(task.status)) return 'Inspect and resume';
  if (['completed', 'cancelled'].includes(task.status)) return 'View result';
  const run = currentTaskRun(task);
  if (run?.status === 'running') return `${run.harness} · ${runLabel(run)}`;
  return stageNames[task.stage] ?? 'Waiting for an agent';
}
export function workflowBoard(tasks, { showEmpty = false } = {}) {
  const visibleColumns = columns.filter(
    ([id]) => (showEmpty && id !== 'cancelled') || tasks.some((t) => workflowColumn(t) === id),
  );
  return `<nav class="board-stage-nav" aria-label="Jump to workflow stage">${visibleColumns.map(([id, title]) => `<button data-action="board-lane" data-lane="${id}">${title} <span>${tasks.filter((t) => workflowColumn(t) === id).length}</span></button>`).join('')}<small>Scroll across stages →</small></nav><div class="workflow-board" aria-label="Task workflow board">${columns
    .filter(
      ([id]) => (showEmpty && id !== 'cancelled') || tasks.some((t) => workflowColumn(t) === id),
    )
    .map(([id, title, hint]) => {
      const lane = tasks.filter((t) => workflowColumn(t) === id);
      return `<section class="board-column column-${id}" data-lane="${id}" data-count="${lane.length}" aria-label="${title}"><header><h2>${title} <span>${lane.length}</span></h2><p>${hint}</p></header><div class="board-cards">${lane.map((t) => `<button class="board-card" data-action="open-task" data-id="${e(t.id)}"><div class="board-card-meta"><span>${e(t.id.slice(0, 8))}</span>${t.demo ? '<em class="demo-label">DEMO</em>' : ''}</div><strong>${e(t.title)}</strong><small>${e((t.repositories?.length ? t.repositories : [t]).map((r) => r.repository.name).join(' + '))}</small>${badge(displayStatus(t))}${t.error || t.latestSummary ? `<p>${e(t.error || t.latestSummary)}</p>` : ''}<footer><span>${e(nextStep(t))}</span><span>${harnessBadge(currentTaskRun(t)?.harness ?? (t.stage === 'verify' ? t.routing?.implement : t.routing?.[t.stage]))}</span></footer><time>${ago(t.updatedAt)}</time></button>`).join('') || '<div class="board-empty">No tasks</div>'}</div></section>`;
    })
    .join('')}</div>`;
}
