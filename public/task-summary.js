import { taskRuns, currentTaskRun } from './task-runs.js';
import { runLabel, isVerificationAgent } from './run-label.js';
import { e, stageNames } from './ui.js';
export function concise(text, max = 240) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= max) return value;
  const boundary = value.lastIndexOf(' ', max - 1);
  return `${value.slice(0, boundary > max / 2 ? boundary : max - 1)}…`;
}
export function taskSummary(task, events = []) {
  const attempt = currentTaskRun(task);
  const latest = (task.attempts ?? []).findLast((run) => run.handoff)?.handoff;
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  const publishing = entries.find(
    (entry) => entry.delivery?.status === 'running' || entry.submission?.status === 'running',
  );
  const publicationBlocked =
    task.status === 'completed' &&
    entries.find((entry) => ['blocked', 'interrupted'].includes(entry.delivery?.status));
  const progress = events.findLast(
    (event) =>
      event.type === 'activity' && event.attemptId === attempt?.id && event.kind === 'message',
  );
  const hostVerification =
    task.attempts?.at(-1)?.role === 'verifier' && ['running', 'queued'].includes(task.status);
  const recovering = task.recovery?.active && ['running', 'queued'].includes(task.status);
  const followUp = (task.deliveryRuns ?? []).findLast(
    (run) => run.stage === 'followup' && run.status === 'running',
  );
  const next = followUp
    ? 'Follow the agent in Activity or Terminals.'
    : publishing
      ? 'The agent is preparing and publishing accepted changes. Follow its run below.'
      : publicationBlocked
        ? 'Open PR details to inspect the publishing blocker and retry.'
        : hostVerification
          ? task.stage === 'verify'
            ? 'The agent is running required checks and investigating failures before independent review.'
            : 'Check results return to the interrupted agent, then the workflow continues.'
          : recovering
            ? 'Debugger is investigating the blocker. No action needed.'
            : ({
                draft: 'Start when ready.',
                awaiting_plan: 'Choose an approach below.',
                awaiting_final: 'Review the code changes and accept or request repairs.',
                blocked: task.recovery?.exhausted
                  ? `Recovery stopped after ${task.recovery.attempts} attempts. Choose a direction in the blocker decision below.`
                  : 'Inspect the latest handoff, add direction, and resume.',
                interrupted: 'Resume to continue from the saved conversation.',
                paused: 'Resume when ready.',
                manual: 'Return control when you are ready for automation.',
                completed:
                  task.preset === 'investigate'
                    ? 'Review the findings. Duplicate this task to plan an implementation.'
                    : 'Accepted. No action needed.',
                cancelled: 'Cancelled. No action needed.',
              }[task.status] ?? 'Agents will continue and bring the next decision to you.');
  const live = ['running', 'queued'].includes(task.status);
  const summary =
    (followUp
      ? progress?.summary || 'The selected agent is working on your follow-up request.'
      : null) ||
    (publishing ? publishing.delivery?.summary || 'Publishing accepted changes.' : null) ||
    (publicationBlocked ? publicationBlocked.delivery?.summary : null) ||
    task.error ||
    (hostVerification
      ? isVerificationAgent(attempt)
        ? 'The verification agent is checking affected behavior and investigating failures.'
        : 'Running configured repository checks.'
      : null) ||
    (recovering
      ? task.recovery.reason
      : progress?.summary ||
        (live
          ? `${stageNames[task.stage] ?? 'Work'} is starting with the saved task context.`
          : latest?.summary));
  return `<section class="task-summary" aria-label="Current task context"><div><span class="eyebrow">${recovering ? 'RESOLVING A BLOCKER' : 'CURRENT STATUS'}</span><h2>${e(followUp ? 'Follow-up' : publishing ? runLabel(attempt ?? { stage: 'publish' }) : publicationBlocked ? 'Publishing needs attention' : hostVerification ? runLabel(attempt) : recovering ? 'Debugger' : task.status === 'completed' ? (task.preset === 'investigate' ? 'Investigation complete' : 'Done') : (stageNames[task.stage] ?? 'Ready'))}</h2><p>${e(concise(summary || task.title))}</p></div><div class="summary-next"><strong>${publicationBlocked || ['awaiting_plan', 'awaiting_final', 'blocked', 'manual', 'interrupted', 'paused', 'draft'].includes(task.status) ? 'Your next step' : 'What happens next'}</strong><p>${e(next)}</p></div></section>`;
}

export function activityArchiveCount(task, events) {
  let count = Math.max(0, events.length - 8);
  const attempt = task.attempts?.at(-1);
  if (['running', 'queued'].includes(task.status) && attempt?.status === 'running') {
    const current = events.findIndex(
      (event) =>
        event.attemptId === attempt.id ||
        (event.type === 'stage_started' &&
          event.stage === attempt.stage &&
          event.at >= attempt.startedAt),
    );
    if (current > count) count = current;
  }
  return count;
}
