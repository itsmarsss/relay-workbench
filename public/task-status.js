import { currentTaskRun } from './task-runs.js';
export function followUpRunning(task) {
  const run = currentTaskRun(task);
  return run?.stage === 'followup' && run.status === 'running';
}
export const overrideStatuses = {
  draft: 'Backlog',
  running: 'In progress',
  awaiting_plan: 'Choose an approach',
  awaiting_final: 'Final approval',
  review: 'In review',
  completed: 'Done',
  finished: 'Completed',
  blocked: 'Needs attention',
  cancelled: 'Cancelled',
};
export function displayStatus(task) {
  if (task.statusOverride?.value) return task.statusOverride.value;
  if (followUpRunning(task)) return 'running';
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  if (entries.some((e) => e.delivery?.status === 'running' || e.submission?.status === 'running'))
    return 'publishing';
  if (
    task.status === 'completed' &&
    entries.some((e) => ['blocked', 'interrupted'].includes(e.delivery?.status))
  )
    return 'blocked';
  return task.status;
}
