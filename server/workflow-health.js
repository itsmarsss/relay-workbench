import { currentTaskRun } from '../public/task-runs.js';

// Heartbeats, transcript chunks and repeated check polls are not progress.
export function workflowHealth(task, events = [], now = Date.now()) {
  const run = currentTaskRun(task);
  if (run?.status !== 'running' || (!run.auxiliary && task.status !== 'running')) {
    const waiting = {
      queued: 'Waiting for an available agent or workspace',
      awaiting_plan: 'Waiting for an approach',
      awaiting_final: 'Waiting for final review',
      paused: 'Paused',
      blocked: 'Waiting for a blocker resolution',
      interrupted: 'Waiting to resume interrupted work',
      manual: 'You have terminal control',
    };
    return { state: task.status, summary: waiting[task.status] ?? '', quiet: false };
  }
  const started = Date.parse(run.startedAt);
  let lastAt = started,
    operation = 'Waiting for first output',
    signature = '';
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.attemptId !== run.id || at < started || !Number.isFinite(at)) continue;
    if (!['activity', 'check_evidence'].includes(event.type)) continue;
    if (/^Check progress:/i.test(event.summary ?? '')) continue;
    const current = JSON.stringify([event.kind, event.summary, event.checks]);
    if (current === signature) continue;
    signature = current;
    lastAt = Math.max(lastAt, at);
    operation = (event.summary || event.details || 'Agent is working').slice(0, 240);
  }
  const quietAfterMs = 10 * 60 * 1000;
  const quiet = Number.isFinite(lastAt) && now - lastAt >= quietAfterMs;
  return {
    state: quiet ? 'quiet' : 'working',
    quiet,
    attemptId: run.id,
    lastAt: Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : run.startedAt,
    operation,
    summary: quiet ? 'No recent output · inspect the last operation' : operation,
    quietAfterMs,
  };
}

export function readWorkflowHealth(store, task, now = Date.now()) {
  const run = currentTaskRun(task);
  if (run?.status !== 'running') return workflowHealth(task, [], now);
  const events = store.db
    .prepare(
      "SELECT body FROM events WHERE task_id=? AND json_extract(body, '$.attemptId')=? AND json_extract(body, '$.type') IN ('activity','check_evidence') ORDER BY seq",
    )
    .all(task.id, run.id)
    .map((row) => JSON.parse(row.body));
  return workflowHealth(task, events, now);
}
