import { decisionBrief } from '../public/workflow-insights.js';
import { workspaces } from './task-repositories.js';
const labels = {
  awaiting_plan: 'Choose an approach',
  awaiting_final: 'Review and accept',
  blocked: 'Resolve a blocker',
  interrupted: 'Inspect interrupted work',
  manual: 'Return control when ready',
};
function feedbackBlocker(task) {
  return (
    task.status === 'completed' &&
    workspaces(task).find((e) => e.feedbackAutopilot?.current?.state === 'needs_decision')
  );
}
function publishingBlocker(task) {
  return (
    task.status === 'completed' &&
    workspaces(task).find((entry) => ['blocked', 'interrupted'].includes(entry.delivery?.status))
  );
}
export function inbox(store) {
  return store
    .all()
    .filter((task) => labels[task.status] || publishingBlocker(task) || feedbackBlocker(task))
    .map((task) => {
      const publishing = publishingBlocker(task);
      const feedback = feedbackBlocker(task);
      const event = store.db
        .prepare(
          "SELECT seq FROM events WHERE task_id=? AND json_extract(body, '$.type') IN ('decision','blocked','interrupted','manual','approval','stage_completed') ORDER BY seq DESC LIMIT 1",
        )
        .get(task.id);
      const key = feedback
        ? `${task.id}:feedback:${feedback.feedbackAutopilot.current.id}`
        : publishing
          ? `${task.id}:publishing:${publishing.delivery.id}:${publishing.delivery.status}`
          : `${task.id}:${task.status}:${event?.seq ?? 0}:${task.attempts.at(-1)?.id ?? 'none'}`;
      const seen = !!store.db.prepare('SELECT value FROM meta WHERE key=?').get(`seen:${key}`);
      return {
        key,
        taskId: task.id,
        title: task.title,
        status: publishing ? 'blocked' : task.status,
        action: feedback
          ? 'Review PR feedback'
          : publishing
            ? 'Resolve publishing blocker'
            : task.status === 'blocked' && task.blockerDecision
              ? 'Choose a blocker resolution'
              : labels[task.status],
        summary:
          (feedback ? feedback.feedbackAutopilot.current.reason : null) ||
          (publishing ? publishing.delivery.nextAction || publishing.delivery.summary : null) ||
          task.error ||
          task.attempts.findLast((a) => a.handoff)?.handoff.summary ||
          '',
        brief: feedback
          ? {
              ...decisionBrief(task),
              recommendation: feedback.feedbackAutopilot.current.reason,
              evidence: feedback.feedbackAutopilot.current.items.map((item) => item.summary),
              options: [],
            }
          : decisionBrief(task),
        revision: task.configRevision ?? 0,
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
