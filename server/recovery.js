// Recovery never changes permissions, approves work, or bypasses checks.
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

// A blocked handoff is a completed diagnosis. Reopening its conversation can
// anchor every retry on the same conclusion, so carry its evidence into a new one.
export function resumableAttempt(task, stage, harness, repositoryId) {
  if (task.recovery?.active) return undefined;
  const latest = (task.attempts ?? []).findLast(
    (a) => a.stage === stage && a.harness === harness && a.repositoryId === repositoryId,
  );
  return latest?.sessionId && !latest.handoff && ['failed', 'interrupted'].includes(latest.status)
    ? latest
    : undefined;
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
