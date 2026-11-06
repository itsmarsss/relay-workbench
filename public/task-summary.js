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
  const latest = task.attempts?.findLast((attempt) => attempt.handoff)?.handoff;
  const progress = events.findLast(
    (event) =>
      event.type === 'activity' &&
      event.attemptId === task.attempts?.at(-1)?.id &&
      event.kind === 'message',
  );
  const hostVerification =
    task.attempts?.at(-1)?.role === 'verifier' && ['running', 'queued'].includes(task.status);
  const recovering = task.recovery?.active && ['running', 'queued'].includes(task.status);
  const next = hostVerification
    ? 'Check results return to the interrupted agent, then the workflow continues.'
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
          completed: 'Accepted. No action needed.',
          cancelled: 'Cancelled. No action needed.',
        }[task.status] ?? 'Agents will continue and bring the next decision to you.');
  const live = ['running', 'queued'].includes(task.status);
  const summary =
    task.error ||
    (hostVerification ? 'Running configured repository checks on the Relay host.' : null) ||
    (recovering
      ? task.recovery.reason
      : progress?.summary ||
        (live
          ? `${stageNames[task.stage] ?? 'Work'} is starting with the saved task context.`
          : latest?.summary));
  return `<section class="task-summary" aria-label="Current task context"><div><span class="eyebrow">${recovering ? 'RESOLVING A BLOCKER' : 'CURRENT STATUS'}</span><h2>${e(hostVerification ? 'Host verification' : recovering ? 'Debugger investigation' : (stageNames[task.stage] ?? 'Ready'))}</h2><p>${e(concise(summary || task.title))}</p></div><div class="summary-next"><strong>${['awaiting_plan', 'awaiting_final', 'blocked', 'manual', 'interrupted', 'paused', 'draft'].includes(task.status) ? 'Your next step' : 'What happens next'}</strong><p>${e(next)}</p></div></section>`;
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
