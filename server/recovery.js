// Give an interrupted specialist its own conversation back before escalating.
export function recoverInPlace(task, reason) {
  const attempt = task.attempts?.at(-1);
  const key = `${task.stage}:${task.repositoryCursor ?? 0}:${task.round ?? 0}`;
  if (
    !attempt?.sessionId ||
    attempt.role === 'debug' ||
    attempt.harness === 'checks' ||
    (task.localRecovery?.key === key && task.localRecovery.attempts >= 1)
  )
    return false;
  task.localRecovery = { key, attempts: 1, sourceAttemptId: attempt.id };
  task.recovery = {
    ...task.recovery,
    key: `${task.stage}:${task.repositoryCursor ?? 0}`,
    phase: 'continue',
    active: false,
    sourceAttemptId: attempt.id,
    reason,
  };
  task.status = 'queued';
  task.error = null;
  task.blockerDecision = null;
  return true;
}

// Recovery does not approve source work or bypass checks; debugger execution is host-level.
export function recoverBlocked(task, handoff, limit = 2, explicit = false) {
  const key = `${task.stage}:${task.repositoryCursor ?? 0}`;
  const previous = task.recovery?.key === key ? task.recovery : null;
  const attempts = previous?.attempts ?? 0;
  const repeated = previous?.reason === handoff.summary;
  const designDecision =
    !explicit &&
    task.attempts?.at(-1)?.role === 'debug' &&
    handoff.options?.length > 0 &&
    handoff.options.every((option) => option.id.startsWith('design-'));
  const retry = !designDecision && attempts < limit && !(repeated && attempts > 1);
  task.recovery = {
    key,
    sourceAttemptId:
      previous?.sourceAttemptId ??
      (task.attempts ?? []).findLast(
        (a) =>
          a.role !== 'debug' &&
          a.role !== 'verifier' &&
          a.stage === task.stage &&
          (a.repositoryId ?? null) === (task.attempts?.at(-1)?.repositoryId ?? null),
      )?.id,
    attempts: attempts + (retry ? 1 : 0),
    reason: handoff.summary,
    phase: 'debug',
    strategy: attempts >= 1 ? 'independent_diagnosis' : 'fresh_diagnosis',
    evidence: (task.attempts ?? [])
      .filter(
        (a) =>
          a.stage === task.stage &&
          (a.repositoryId ?? null) ===
            (task.repositories?.length > 1 &&
            ['investigate', 'implement', 'review'].includes(task.stage)
              ? task.repositories[task.repositoryCursor ?? 0].repository.id
              : null) &&
          a.handoff?.verdict === 'blocked',
      )
      .slice(-3)
      .map((a) => ({
        harness: a.harness,
        summary: a.handoff.summary,
        details: a.handoff.details?.slice(-4000),
        evidence: a.handoff.evidence?.slice(-12),
        risks: a.handoff.risks?.slice(-8),
      })),
    active: retry,
    exhausted: !retry,
  };
  if (!retry) task.blockerDecision = blockerDecision(task, handoff);
  else task.blockerDecision = null;
  task.status = retry ? 'queued' : 'blocked';
  task.error = retry ? null : handoff.summary;
  return retry;
}

// Diagnosis starts fresh; continuation returns to the interrupted specialist.
export function resumableAttempt(task, stage, harness, repositoryId) {
  if (task.recovery?.active) return undefined;
  const continuing = ['continue', 'retry_stage'].includes(task.recovery?.phase);
  const latest = (task.attempts ?? []).findLast(
    (a) =>
      a.role !== 'debug' &&
      (a.role !== 'verifier' || stage === 'verify') &&
      a.stage === stage &&
      a.harness === harness &&
      a.repositoryId === repositoryId &&
      (!continuing || !task.recovery.sourceAttemptId || a.id === task.recovery.sourceAttemptId),
  );
  return latest?.sessionId &&
    (continuing || (!latest.handoff && ['failed', 'interrupted'].includes(latest.status)))
    ? latest
    : undefined;
}

export function continuationContext(task, stage, repositoryId) {
  if (
    !['continue', 'retry_stage'].includes(task.recovery?.phase) ||
    task.recovery.key !== `${stage}:${task.repositoryCursor ?? 0}`
  )
    return undefined;
  const source = task.attempts.findLast(
    (a) =>
      (!task.recovery.sourceAttemptId || a.id === task.recovery.sourceAttemptId) &&
      a.role !== 'debug' &&
      a.role !== 'verifier' &&
      a.stage === stage &&
      (a.repositoryId ?? null) === (repositoryId ?? null),
  );
  return {
    sourceAttemptId: source?.id,
    completedWork: source?.handoff ?? null,
    interruption: source?.error ?? task.recovery.reason,
    diagnosis: task.recovery.lastDiagnosis,
    filesPreserved: true,
  };
}

export function recoveryHarnesses(task, configured, harnesses) {
  if (!task.recovery?.active || task.recovery.attempts < 2) return [configured];
  return [
    ...Object.keys(harnesses).filter((id) => id !== configured && harnesses[id].enabled),
    configured,
  ];
}

export function blockerDecision(task, handoff) {
  const debugAttempts = (task.attempts ?? []).filter(
    (a) => a.role === 'debug' && a.stage === task.stage,
  );
  return {
    id: debugAttempts.at(-1)?.id ?? task.attempts?.at(-1)?.id ?? `${task.stage}:${task.round ?? 0}`,
    stage: task.stage,
    summary: handoff.summary,
    explanation: handoff.details ?? '',
    evidence: handoff.evidence ?? [],
    required: handoff.risks ?? [],
    options: handoff.options ?? [],
    debugAttempts: debugAttempts.length,
    resolved: false,
  };
}
