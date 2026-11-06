// Recovery never changes permissions, approves work, or bypasses checks.
export function recoverBlocked(task, handoff, limit = 2) {
  const key = `${task.stage}:${task.repositoryCursor ?? 0}`;
  const previous = task.recovery?.key === key ? task.recovery : null;
  const attempts = previous?.attempts ?? 0;
  const repeated = previous?.reason === handoff.summary;
  const retry = attempts < limit && !(repeated && attempts > 1);
  task.recovery = {
    key,
    attempts: attempts + (retry ? 1 : 0),
    reason: handoff.summary,
    active: retry,
    exhausted: !retry,
  };
  task.status = retry ? 'queued' : 'blocked';
  task.error = retry ? null : handoff.summary;
  return retry;
}
