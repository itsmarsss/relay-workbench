// Compare actual failures on identical source state, never time budgets or mere output frequency.
export function applyLoopGuard(task, attempt) {
  if (
    !['blocked', 'changes_requested'].includes(attempt.handoff?.verdict) ||
    !attempt.fingerprint ||
    attempt.fingerprint === 'demo'
  )
    return false;
  const previous = (task.attempts ?? [])
    .slice(task.loopGuardAcknowledgedAt ?? 0)
    .filter(
      (r) =>
        r.stage === attempt.stage &&
        (r.repositoryId ?? null) === (attempt.repositoryId ?? null) &&
        ['blocked', 'changes_requested'].includes(r.handoff?.verdict) &&
        r.fingerprint === attempt.fingerprint &&
        r.handoff.summary.trim().toLowerCase() === attempt.handoff.summary.trim().toLowerCase() &&
        JSON.stringify(r.handoff.evidence ?? []) === JSON.stringify(attempt.handoff.evidence ?? []),
    );
  if (previous.length < 2) return false;
  const stopped = previous.length >= 3;
  task.loopGuard = {
    count: previous.length,
    stopped,
    sourceAttemptId: attempt.id,
    guidance:
      'This exact failure already occurred on unchanged source. Read the prior command results, test a different supported hypothesis, and reuse passing checks. Do not rerun the same failed sequence without new evidence.',
    evidence: previous.map((r) => ({
      id: r.id,
      summary: r.handoff.summary,
      evidence: r.handoff.evidence ?? [],
    })),
  };
  if (stopped) {
    task.status = 'blocked';
    if (task.recovery) task.recovery.active = false;
    task.error = 'Repeated failure on unchanged source after recovery attempts.';
    task.blockerDecision ??= {
      id: attempt.id,
      kind: 'loop_guard',
      summary: task.error,
      explanation: task.loopGuard.guidance,
      evidence: previous.flatMap((r) => r.handoff.evidence ?? []).slice(-12),
      required: ['Choose a revised approach or supply new diagnostic direction before retrying.'],
      options: [],
      resolved: false,
    };
  }
  return true;
}
