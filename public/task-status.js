export const overrideStatuses = {
  draft: 'Backlog',
  running: 'In progress',
  review: 'In review',
  completed: 'Done',
  blocked: 'Needs attention',
  cancelled: 'Cancelled',
};
export function displayStatus(task) {
  if (task.statusOverride?.value) return task.statusOverride.value;
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
