import type { Task } from './types';
export const stageNames: Record<string, string> = {
  triage: 'Triage',
  investigate: 'Investigation',
  plan: 'Solution design',
  implement: 'Implementation',
  verify: 'Verification agent',
  review: 'Independent review',
  publish: 'Publish',
  monitor: 'PR feedback',
};
export function nextStep(task: Task): string {
  return (
    (
      {
        draft: 'Start investigation',
        queued: 'Waiting for an agent',
        running: stageNames[task.stage || ''] || 'Agent working',
        awaiting_plan: 'Choose an approach',
        awaiting_final: 'Review and accept',
        blocked: 'Review the blocker',
        interrupted: 'Inspect and resume',
        paused: 'Resume workflow',
        manual: 'Return to automation',
        completed: 'Review delivery',
        finished: 'Work completed',
        cancelled: 'Cancelled',
      } as Record<string, string>
    )[task.status] || 'Open task'
  );
}
export function ago(value?: string): string {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return 'No updates yet';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
