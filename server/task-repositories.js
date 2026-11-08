// Legacy tasks retain their original single-workspace representation.
export function workspaces(task) {
  return task.repositories?.length > 1 ? task.repositories : [task];
}
export function workspaceView(task, entry) {
  return entry === task ? task : { ...task, ...entry, repositories: undefined };
}
export function syncPrimary(task) {
  if (task.repositories?.length > 1) {
    const primary = task.repositories.find((r) => r.repository.id === task.repository.id);
    for (const key of ['workspace', 'workspaceRoot', 'baseCommit', 'branch', 'workspaceHead'])
      task[key] = primary[key];
  }
}
