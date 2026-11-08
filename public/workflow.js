import { currentTaskRun } from './task-runs.js';
import { runLabel } from './run-label.js';
import { displayStatus, followUpRunning } from './task-status.js';
import { e, badge, harnessBadge, stageNames, ago, icon } from './ui.js';

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
export const boardStatuses = {
  backlog: 'draft',
  discovery: 'running',
  approach: 'awaiting_plan',
  progress: 'running',
  review: 'review',
  final: 'awaiting_final',
  done: 'completed',
  attention: 'blocked',
  cancelled: 'cancelled',
};
export function workflowColumn(task) {
  if (
    task.statusOverride?.lane &&
    boardStatuses[task.statusOverride.lane] === task.statusOverride.value
  )
    return task.statusOverride.lane;
  const shown = displayStatus(task);
  if (task.statusOverride || shown !== task.status)
    return (
      {
        draft: 'backlog',
        awaiting_plan: 'approach',
        awaiting_final: 'final',
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
  return `<nav class="board-stage-nav ${visibleColumns.length <= 3 ? 'is-short' : ''}" aria-label="Jump to workflow stage">${visibleColumns.map(([id, title]) => `<button data-action="board-lane" data-lane="${id}"><span class="lane-dot lane-dot-${id}"></span>${title}<span class="lane-count">${tasks.filter((t) => workflowColumn(t) === id).length}</span></button>`).join('')}</nav><p class="board-drag-hint" id="board-drag-hint">Drag cards to update their board status. Workflow and approvals stay unchanged. Press M on a focused card to move it with the keyboard.</p><div class="workflow-board" aria-label="Task workflow board" tabindex="0">${columns
    .map(([id, title, hint]) => {
      const lane = tasks.filter((t) => workflowColumn(t) === id);
      return `<section class="board-column column-${id}" data-lane="${id}" data-count="${lane.length}" ${visibleColumns.some(([key]) => key === id) ? '' : 'hidden'} aria-label="${title}"><header><h2><span class="lane-title"><span class="lane-dot lane-dot-${id}"></span>${title}</span><span class="lane-count">${lane.length}</span></h2><p>${hint}</p></header><div class="board-cards">${
        lane
          .map((t) => {
            const repository = (t.repositories?.length ? t.repositories : [t])
              .map((r) => r.repository.name)
              .join(' + ');
            const run = currentTaskRun(t);
            const harness =
              run?.harness ?? (t.stage === 'verify' ? t.routing?.implement : t.routing?.[t.stage]);
            const issue = t.ticket?.match(/\/(?:issues|pull|pulls)\/(\d+)/)?.[1];
            return `<article class="board-card-container"><button class="board-card" draggable="true" aria-describedby="board-drag-hint" data-action="open-task" data-id="${e(t.id)}"><div class="board-card-meta">${badge(displayStatus(t))}${t.demo ? '<em class="demo-label">DEMO</em>' : ''}</div><strong>${e(t.title)}</strong><small class="board-repository">${icon('folder')}${e(repository)}</small>${t.error || t.latestSummary ? `<p class="board-card-summary ${t.error ? 'is-error' : ''}">${e(t.error || t.latestSummary)}</p>` : ''}<div class="board-next-step">${icon(['approach', 'final', 'attention'].includes(id) ? 'eye' : id === 'done' ? 'check' : 'arrow')}<span>${e(nextStep(t))}</span>${harness ? harnessBadge(harness) : ''}</div><footer><span class="board-task-reference">${issue ? `#${e(issue)}` : e(t.id.slice(0, 8))}</span><time>${ago(t.updatedAt)}</time></footer></button><button class="board-move" data-action="move-board-task" data-id="${e(t.id)}" aria-label="Move task: ${e(t.title)}" title="Move task">${icon('move')}</button></article>`;
          })
          .join('') || '<div class="board-empty">No tasks in this stage</div>'
      }</div></section>`;
    })
    .join('')}</div>`;
}
