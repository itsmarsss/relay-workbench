import { e, stageNames } from './ui.js';
export function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function timer(start, end, now = Date.now()) {
  const timestamp = Date.parse(start);
  if (!Number.isFinite(timestamp)) return '';
  const finish = end ? Date.parse(end) : now;
  return `<time class="elapsed-time" ${end ? '' : `data-live-start="${e(start)}"`} aria-label="Elapsed time">${elapsed(finish - timestamp)}</time>`;
}
export function liveProgress(task, events = []) {
  const attempt = task.attempts?.findLast((a) => a.status === 'running');
  if (task.status !== 'running' || !attempt) return '';
  const activity = events.findLast((e) => e.attemptId === attempt.id && e.type === 'activity');
  return `<div class="live-progress" aria-label="Live task progress"><span class="pulse-dot"></span><strong>${attempt.role === 'debug' ? 'Debugger' : (stageNames[attempt.stage] ?? attempt.stage)}</strong><span>${e(attempt.harness)}</span>${timer(attempt.startedAt)}${activity?.at ? `<small>Last activity ${timer(activity.at)} ago</small>` : '<small>Waiting for first output</small>'}<small>Elapsed time · completion is not estimated</small></div>`;
}
export function updateTimers(root = document, now = Date.now()) {
  for (const node of root.querySelectorAll('[data-live-start]'))
    node.textContent = elapsed(now - Date.parse(node.dataset.liveStart));
}
