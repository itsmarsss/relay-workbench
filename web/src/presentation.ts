import { statusLabel, type Task } from './types';
export const stageNames: Record<string, string> = {
  triage: 'Triage',
  investigate: 'Investigation',
  plan: 'Solution design',
  implement: 'Implementation',
  verify: 'Verification',
  review: 'Independent review',
  publish: 'Publish',
  monitor: 'PR feedback',
  followup: 'Follow-up',
};
// The stage a task is at. While an agent is working that is the run's stage; once it has
// stopped, the last run is history and the workflow's own stage says where it will pick up.
export function currentStage(task: Pick<Task, 'stage' | 'currentRun'> | undefined): string {
  const run = task?.currentRun;
  return (run?.status === 'running' && run.stage) || task?.stage || run?.stage || '';
}
// Agent summaries are Markdown; places that show them as one line drop the markup.
export function plainSummary(value?: string | null): string {
  return (value || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
// The task's pull request states, from the list summary or the full task (published or linked).
function pullRequestStates(task: Task): string[] {
  if (task.pullRequests?.length) return task.pullRequests.map((pr) => pr.state || '');
  const full = task as unknown as Record<string, unknown>;
  const rows =
    Array.isArray(full.repositories) && full.repositories.length > 1 ? full.repositories : [full];
  return rows.flatMap((row) => {
    const entry = (row || {}) as Record<string, Record<string, unknown> | undefined>;
    const pr = entry.publication?.url ? entry.publication : entry.pullRequestLink;
    return pr?.url ? [String(pr.state || '')] : [];
  });
}
export function nextStep(task: Task): string {
  if (task.status === 'completed') {
    const states = pullRequestStates(task);
    if (!states.length) return 'Publish or follow up';
    return states.every((state) => state === 'merged')
      ? 'Pull request merged'
      : 'Pull request open';
  }
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
export const repositoryNames = (task: Task): string =>
  (task.repositories?.length
    ? task.repositories
        .map((row) => row.repository?.name)
        .filter(Boolean)
        .join(' + ')
    : task.repository?.name) || 'Unspecified';
export function ticketURL(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
// GitHub-style issue URLs read better as owner/repo#number.
export function ticketLabel(url: string): string {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull|pulls)\/(\d+)/.exec(url);
  return match ? `${match[1]}#${match[2]}` : url.replace(/^https?:\/\//, '');
}
// The short reference a developer scans for in a list: #2462, or the raw ticket text.
export function ticketRef(ticket?: string): string {
  if (!ticket) return '';
  const number = /\/(?:issues|pull|pulls)\/(\d+)/.exec(ticket)?.[1];
  return number ? `#${number}` : ticket.replace(/^https?:\/\//, '');
}
// Why the task stopped, in words a developer can scan down a column.
export const waitingKind = (task: Task) =>
  (
    ({
      awaiting_plan: 'Approach approval',
      awaiting_final: 'Final approval',
      blocked: 'Blocked',
      interrupted: 'Interrupted',
      paused: 'Paused',
      manual: 'Manual control',
    }) as Record<string, string>
  )[task.status] || statusLabel(task.status);

// Where a stopped or working task is, when the stage is not already implied by its status.
export const stageNote = (task: Task): string =>
  ['blocked', 'interrupted', 'paused', 'manual', 'queued'].includes(task.status)
    ? stageNames[currentStage(task)] || ''
    : '';
// What a person is being asked to do, named for the decision rather than the status.
export function decisionLabel(task: Task): string {
  return (
    (
      {
        awaiting_plan: 'Choose approach',
        awaiting_final: 'Review result',
        blocked: 'Resolve blocker',
        interrupted: 'Inspect and resume',
        paused: 'Resume',
        manual: 'Return to automation',
      } as Record<string, string>
    )[task.status] || nextStep(task)
  );
}
export function shortDate(value?: string): string {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}
