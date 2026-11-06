import { e, stageNames, harnessBadge, ago } from './ui.js';
import { concise } from './task-summary.js';

export function activityRunSelection(task, events, selection = 'latest') {
  const attempts = task.attempts ?? [];
  const current = attempts.at(-1);
  const selected =
    selection === 'all' ? null : (attempts.find((a) => a.id === selection) ?? current);
  return {
    selected,
    current,
    events: selected
      ? events.filter(
          (ev) =>
            ev.attemptId === selected.id ||
            (!ev.attemptId &&
              ev.type === 'stage_started' &&
              ev.stage === selected.stage &&
              ev.at === selected.startedAt),
        )
      : events,
  };
}
export function activityRunNavigation(task, selected, selection) {
  const attempts = task.attempts ?? [];
  const label = (a) =>
    a.role === 'verifier' || a.harness === 'checks'
      ? 'Host checks'
      : a.role === 'debug'
        ? 'Debugger'
        : (stageNames[a.stage] ?? a.stage);
  return `<nav class="activity-runs" aria-label="Activity runs"><div class="activity-runs-heading"><strong>Run history</strong><span>${attempts.length}</span></div><button class="activity-run-follow ${selection === 'latest' ? 'selected' : ''}" data-action="activity-run" data-run="latest" aria-pressed="${selection === 'latest'}">Follow current run <span>↗</span></button><div class="activity-run-list">${attempts
    .map((a, i) => ({ a, i }))
    .reverse()
    .map(
      ({ a, i }) =>
        `<button class="activity-run ${selected?.id === a.id ? 'selected' : ''}" data-action="activity-run" data-run="${e(a.id)}" aria-pressed="${selected?.id === a.id}"><span class="activity-run-number">${i + 1}</span><span><strong>${e(label(a))}</strong><small>${e(a.harness)} · ${e(a.status === 'running' ? 'Running' : a.handoff?.verdict === 'blocked' ? 'Blocked' : a.status)}</small></span><span class="run-state ${a.status === 'running' ? 'live' : ''}">${a.status === 'running' ? '●' : a.handoff?.verdict === 'blocked' || a.status === 'failed' ? '!' : '·'}</span></button>`,
    )
    .join(
      '',
    )}</div><button class="activity-run-all ${selection === 'all' ? 'selected' : ''}" data-action="activity-run" data-run="all" aria-pressed="${selection === 'all'}">All activity</button></nav>`;
}
export function activityRunHeader(attempt, events) {
  if (!attempt)
    return '<header class="activity-run-header"><div><h2>All activity</h2><p>The complete task history, in order.</p></div></header>';
  const host = attempt.role === 'verifier' || attempt.harness === 'checks';
  const title = host
    ? attempt.harness !== 'checks'
      ? 'Verification agent'
      : 'Host verification'
    : attempt.role === 'debug'
      ? 'Debugger'
      : (stageNames[attempt.stage] ?? attempt.stage);
  const output =
    host && attempt.harness === 'checks'
      ? events
          .filter((ev) => ev.type === 'transcript' && ev.attemptId === attempt.id)
          .slice(-6)
          .map((ev) => ev.text ?? '')
          .join('\n')
          .slice(-2400)
      : '';
  return `<header class="activity-run-header"><div class="activity-run-title">${harnessBadge(attempt.harness)}<div><h2>${e(title)}</h2><p>${e(attempt.status === 'running' ? 'Running now' : attempt.status)} · ${ago(attempt.startedAt)}</p></div></div>${host ? (attempt.harness !== 'checks' ? '<p>An agent discovers checks from repository guidance, runs them on the host and investigates failures.</p>' : '<p>Configured checks run on the Relay host. Results return to the agent; its sandbox permissions stay the same.</p>') : attempt.handoff ? `<p>${e(concise(attempt.handoff.summary))}</p>` : ''}</header>${output ? `<section class="host-output" aria-label="Recent check output"><div>Recent output <span>${attempt.status === 'running' ? 'Live' : 'Saved'}</span></div><pre>${e(output)}</pre></section>` : ''}`;
}
