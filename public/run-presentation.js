import { e, duration } from './ui.js';
import { timer } from './live-progress.js';
export function harnessName(id) {
  return { codex: 'Codex', claude: 'Claude', pi: 'Pi', checks: 'Checks' }[id] ?? id ?? 'Agent';
}
export function runState(run) {
  if (!run) return { key: 'pending', label: 'Pending', mark: '○' };
  if (run.status === 'running') return { key: 'running', label: 'Running', mark: '●' };
  if (run.status === 'queued') return { key: 'pending', label: 'Queued', mark: '○' };
  if (run.status === 'failed' || run.error) return { key: 'failed', label: 'Failed', mark: '!' };
  if (run.handoff?.verdict === 'blocked' || run.status === 'blocked')
    return { key: 'blocked', label: 'Blocked', mark: '!' };
  if (['changes_requested', 'repair_requested'].includes(run.handoff?.verdict))
    return { key: 'changes', label: 'Changes requested', mark: '↻' };
  if (['interrupted', 'paused'].includes(run.status))
    return { key: 'paused', label: 'Paused', mark: 'Ⅱ' };
  if (run.status === 'complete' || run.status === 'completed')
    return { key: 'complete', label: 'Complete', mark: '✓' };
  return { key: 'pending', label: 'Pending', mark: '○' };
}
export function runTiming(run) {
  if (!run?.startedAt) return '';
  if (run.status === 'running') return timer(run.startedAt);
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? e(duration(ms)) : '';
}
export function runMetadata(run, fallback = 'Not started') {
  if (!run) return e(fallback);
  const time = runTiming(run);
  return `${e(harnessName(run.harness))}${time ? `<span aria-hidden="true"> · </span>${time}` : ''}`;
}
export function workflowRow({ title, index, run, state = runState(run), fallback, extra = '' }) {
  return `<li class="workflow-stage ${state.key === 'complete' ? 'done' : state.key === 'running' ? 'current' : ''}" data-stage-state="${e(state.key)}"><span class="stage-number" aria-label="${e(state.label)}">${state.key === 'pending' ? index : e(state.mark)}</span><div class="workflow-stage-body"><div class="workflow-stage-heading"><strong>${e(title)}</strong><span class="run-status ${e(state.key)}">${e(state.label)}</span></div><small class="run-metadata">${runMetadata(run, fallback)}${extra}</small></div></li>`;
}
