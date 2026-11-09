import { runState, runMetadata } from './run-presentation.js';
import { taskRuns } from './task-runs.js';
import { runLabel, isVerificationAgent } from './run-label.js';
import { e, harnessBadge, ago, icon } from './ui.js';
import { concise } from './task-summary.js';

export function activityRunSelection(task, events, selection = 'latest') {
  const attempts = taskRuns(task);
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
      : events.filter(
          (event) =>
            event.stage !== 'monitor' ||
            attempts.some((run) => run.stage === 'feedback' && run.id === event.attemptId) ||
            (event.type === 'publication' && event.observationChange),
        ),
  };
}
export function activityRunNavigation(task, selected, selection) {
  const attempts = taskRuns(task);
  return `<nav class="activity-runs" aria-label="Activity runs"><div class="activity-runs-heading"><strong>Run history</strong><span>${attempts.length}</span></div><button class="activity-run-follow ${selection === 'latest' ? 'selected' : ''}" data-action="activity-run" data-run="latest" aria-pressed="${selection === 'latest'}">Follow current run <span>↗</span></button><div class="activity-run-list">${attempts
    .map((a, i) => ({ a, i }))
    .reverse()
    .map(({ a, i }) => {
      const status = runState(a);
      return `<button class="activity-run ${selected?.id === a.id ? 'selected' : ''}" data-action="activity-run" data-run="${e(a.id)}" aria-pressed="${selected?.id === a.id}"><span class="activity-run-number">${i + 1}</span><span class="activity-run-body"><strong>${e(runLabel(a))}</strong><small class="run-metadata">${runMetadata(a)}</small><span class="run-status ${status.key}">${e(status.label)}</span></span><span class="run-state ${status.key}" aria-hidden="true">${status.mark}</span></button>`;
    })
    .join(
      '',
    )}</div><button class="activity-run-all ${selection === 'all' ? 'selected' : ''}" data-action="activity-run" data-run="all" aria-pressed="${selection === 'all'}">All activity</button></nav>`;
}
export function activityRunHeader(attempt, events) {
  if (!attempt)
    return '<header class="activity-run-header"><div><h2>All activity</h2><p>The complete task history, in order.</p></div></header>';
  const host = attempt.role === 'verifier' || attempt.harness === 'checks';
  const title = runLabel(attempt);
  const output =
    host && attempt.harness === 'checks'
      ? events
          .filter((ev) => ev.type === 'transcript' && ev.attemptId === attempt.id)
          .slice(-6)
          .map((ev) => ev.text ?? '')
          .join('\n')
          .slice(-2400)
      : '';
  return `<header class="activity-run-header"><div class="activity-run-title">${harnessBadge(attempt.harness)}<div><h2>${e(title)}</h2><p>${e(runState(attempt).label)} · ${ago(attempt.startedAt)}</p></div></div>${host ? (isVerificationAgent(attempt) ? '<p>An agent discovers checks from repository guidance, runs them on the host and investigates failures.</p>' : '<p>Configured checks run on the Relay host. Results return to the agent. All workflow agents use host execution.</p>') : attempt.handoff ? `<p>${e(concise(attempt.handoff.summary))}</p>` : ''}</header>${output ? `<section class="host-output" aria-label="Recent check output"><div>Recent output <span>${attempt.status === 'running' ? 'Live' : 'Saved'}</span></div><pre>${e(output)}</pre></section>` : ''}`;
}

// Harness metadata identifies the run; only agent output identifies its speaker.
export function activityEventIdentity(event) {
  const human =
    event.source !== 'relay' && ['feedback', 'approval', 'accepted'].includes(event.type);
  const agent =
    !human &&
    ['activity', 'handoff'].includes(event.type) &&
    event.source !== 'relay' &&
    event.harness &&
    event.harness !== 'checks';
  return {
    name: human
      ? 'You'
      : agent
        ? event.harness.charAt(0).toUpperCase() + event.harness.slice(1)
        : 'Relay',
    harness: agent ? event.harness : null,
    context:
      !agent && event.harness && event.harness !== 'checks'
        ? event.harness.charAt(0).toUpperCase() + event.harness.slice(1)
        : null,
  };
}
export function activityEventMeta(event, stageLabel) {
  const identity = activityEventIdentity(event);
  return `<strong>${e(identity.name)}</strong>${identity.context ? `<span>${e(identity.context)}</span>` : ''}<span>${e(stageLabel ?? event.type.replaceAll('_', ' '))}</span>`;
}

// Derive transitions from recorded run starts, including historical tasks.
export function activityPassoff(task, event) {
  if (event.type !== 'stage_started') return '';
  const runs = taskRuns(task);
  const index = runs.findLastIndex((run) =>
    event.attemptId
      ? run.id === event.attemptId
      : run.stage === event.stage &&
        (!event.harness || run.harness === event.harness) &&
        Date.parse(run.startedAt) <= Date.parse(event.at),
  );
  if (index < 1) return '';
  const previous = runs[index - 1];
  const next = runs[index];
  // Concurrent repository runs are not a transfer of ownership.
  if (!previous.finishedAt || Date.parse(previous.finishedAt) > Date.parse(next.startedAt))
    return '';
  const endpoint = (run) =>
    `<span class="passoff-endpoint"><strong>${e(runLabel(run))}</strong>${run.harness ? `<small>${e(run.harness.charAt(0).toUpperCase() + run.harness.slice(1))}</small>` : ''}</span>`;
  const at = new Date(event.at);
  return `<div class="activity-passoff" aria-label="Work passed between runs"><div class="passoff-heading"><span>Handoff</span><time datetime="${e(event.at)}" title="${e(at.toLocaleString())}">${e(ago(event.at))}</time></div><div class="passoff-route">${endpoint(previous)}<span class="passoff-arrow" aria-label="to">${icon('arrow')}</span>${endpoint(next)}</div></div>`;
}
