import { workspaces } from './task-repositories.js';
const labels = {
  awaiting_plan: 'Choose an approach',
  awaiting_final: 'Review and accept',
  blocked: 'Resolve a blocker',
  interrupted: 'Inspect interrupted work',
  manual: 'Return control when ready',
};
function publishingBlocker(task) {
  return (
    task.status === 'completed' &&
    workspaces(task).find((entry) => ['blocked', 'interrupted'].includes(entry.delivery?.status))
  );
}
export function inbox(store) {
  return store
    .all()
    .filter((task) => labels[task.status] || publishingBlocker(task))
    .map((task) => {
      const publishing = publishingBlocker(task);
      const event = store.db
        .prepare(
          "SELECT seq FROM events WHERE task_id=? AND json_extract(body, '$.type') IN ('decision','blocked','interrupted','manual','approval','stage_completed') ORDER BY seq DESC LIMIT 1",
        )
        .get(task.id);
      const key = publishing
        ? `${task.id}:publishing:${publishing.delivery.id}:${publishing.delivery.status}`
        : `${task.id}:${task.status}:${event?.seq ?? 0}`;
      const seen = !!store.db.prepare('SELECT value FROM meta WHERE key=?').get(`seen:${key}`);
      return {
        key,
        taskId: task.id,
        title: task.title,
        status: publishing ? 'blocked' : task.status,
        action: publishing
          ? 'Resolve publishing blocker'
          : task.status === 'blocked' && task.blockerDecision
            ? 'Choose a blocker resolution'
            : labels[task.status],
        summary:
          (publishing ? publishing.delivery.nextAction || publishing.delivery.summary : null) ||
          task.error ||
          task.attempts.findLast((a) => a.handoff)?.handoff.summary ||
          '',
        updatedAt: task.updatedAt,
        seen,
      };
    });
}
export function acknowledge(store, key) {
  if (!inbox(store).some((item) => item.key === key)) return false;
  store.db
    .prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)')
    .run(`seen:${key}`, new Date().toISOString());
  return true;
}
