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
  return `<nav class="board-stage-nav ${visibleColumns.length <= 3 ? 'is-short' : ''}" aria-label="Jump to workflow stage">${visibleColumns.map(([id, title]) => `<button data-action="board-lane" data-lane="${id}"><span class="lane-dot lane-dot-${id}"></span>${title}<span class="lane-count">${tasks.filter((t) => workflowColumn(t) === id).length}</span></button>`).join('')}</nav><div class="workflow-board" aria-label="Task workflow board" tabindex="0">${visibleColumns
    .map(([id, title, hint]) => {
      const lane = tasks.filter((t) => workflowColumn(t) === id);
      return `<section class="board-column column-${id}" data-lane="${id}" data-count="${lane.length}" aria-label="${title}"><header><h2><span class="lane-title"><span class="lane-dot lane-dot-${id}"></span>${title}</span><span class="lane-count">${lane.length}</span></h2><p>${hint}</p></header><div class="board-cards">${
        lane
          .map((t) => {
            const repository = (t.repositories?.length ? t.repositories : [t])
              .map((r) => r.repository.name)
              .join(' + ');
            const run = currentTaskRun(t);
            const harness =
              run?.harness ?? (t.stage === 'verify' ? t.routing?.implement : t.routing?.[t.stage]);
            const issue = t.ticket?.match(/\/(?:issues|pull|pulls)\/(\d+)/)?.[1];
            return `<button class="board-card" data-action="open-task" data-id="${e(t.id)}"><div class="board-card-meta">${badge(displayStatus(t))}${t.demo ? '<em class="demo-label">DEMO</em>' : ''}</div><strong>${e(t.title)}</strong><small class="board-repository">${icon('folder')}${e(repository)}</small>${t.error || t.latestSummary ? `<p class="board-card-summary ${t.error ? 'is-error' : ''}">${e(t.error || t.latestSummary)}</p>` : ''}<div class="board-next-step">${icon(['approach', 'final', 'attention'].includes(id) ? 'eye' : id === 'done' ? 'check' : 'arrow')}<span>${e(nextStep(t))}</span>${harness ? harnessBadge(harness) : ''}</div><footer><span class="board-task-reference">${issue ? `#${e(issue)}` : e(t.id.slice(0, 8))}</span><time>${ago(t.updatedAt)}</time></footer></button>`;
          })
          .join('') || '<div class="board-empty">No tasks in this stage</div>'
      }</div></section>`;
    })
    .join('')}</div>`;
}
