const stages = ['triage', 'investigate', 'plan', 'implement', 'review'];
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function lowerBound(successes, count) {
  if (!count) return 0;
  const z = 1.96,
    p = successes / count;
  return (
    (p + (z * z) / (2 * count) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * count)) / count)) /
    (1 + (z * z) / count)
  );
}
export function routingOutcomes(tasks, config, repositoryId = '') {
  const groups = new Map();
  for (const task of tasks) {
    if (task.demo) continue;
    const repositories = task.repositories?.length ? task.repositories : [task];
    if (repositoryId && !repositories.some((r) => r.repository.id === repositoryId)) continue;
    for (const [index, attempt] of task.attempts.entries()) {
      if (!stages.includes(attempt.stage) || !['codex', 'claude', 'pi'].includes(attempt.harness))
        continue;
      if (attempt.stage === 'triage' && !task.smartRouting) continue;
      if (repositoryId && attempt.repositoryId && attempt.repositoryId !== repositoryId) continue;
      const model = attempt.model ?? null;
      const key = JSON.stringify([attempt.stage, attempt.harness, model]);
      if (!groups.has(key))
        groups.set(key, {
          stage: attempt.stage,
          harness: attempt.harness,
          model,
          attempts: 0,
          settled: 0,
          successful: 0,
          failed: 0,
          interrupted: 0,
          pending: 0,
          reviewFindings: 0,
          durations: [],
          taskIds: new Set(),
          acceptedTaskIds: new Set(),
        });
      const group = groups.get(key);
      group.attempts++;
      group.taskIds.add(task.id);
      if (task.status === 'completed') group.acceptedTaskIds.add(task.id);
      if (attempt.finishedAt && attempt.startedAt) {
        const duration = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
        if (Number.isFinite(duration) && duration >= 0) group.durations.push(duration);
      }
      group.reviewFindings += attempt.handoff?.findings?.length || 0;
      if (attempt.status === 'interrupted') {
        group.interrupted++;
        continue;
      }
      if (attempt.status === 'running') {
        group.pending++;
        continue;
      }
      let success = attempt.status === 'complete' && attempt.handoff?.verdict === 'complete';
      if (success && attempt.stage === 'review') success = !attempt.handoff.findings?.length;
      if (success && attempt.stage === 'implement') {
        let next = task.attempts.slice(index + 1);
        const stop = next.findIndex(
          (a) => a.stage === 'implement' && a.repositoryId === attempt.repositoryId,
        );
        if (stop >= 0) next = next.slice(0, stop);
        const verification = next.find((a) => a.stage === 'verify' && a.status !== 'running');
        const review = next.find(
          (a) =>
            a.stage === 'review' &&
            a.repositoryId === attempt.repositoryId &&
            a.status !== 'running',
        );
        if (!verification || (verification.handoff?.verdict === 'complete' && !review)) {
          group.pending++;
          continue;
        }
        success =
          verification.status === 'complete' &&
          verification.handoff?.verdict === 'complete' &&
          review?.status === 'complete' &&
          review.handoff?.verdict === 'complete' &&
          !review.handoff.findings?.length;
      }
      group.settled++;
      if (success) group.successful++;
      else group.failed++;
    }
  }
  const rows = [...groups.values()].map((group) => {
    const enabled = config.harnesses[group.harness]?.enabled;
    const configured =
      group.model !== null && group.model === (config.harnesses[group.harness]?.model ?? '');
    return {
      ...group,
      taskIds: undefined,
      acceptedTaskIds: undefined,
      durations: undefined,
      tasks: group.taskIds.size,
      acceptedTasks: group.acceptedTaskIds.size,
      medianMs: percentile(group.durations, 0.5),
      p90Ms: percentile(group.durations, 0.9),
      successRate: group.settled ? group.successful / group.settled : null,
      confidenceLower: lowerBound(group.successful, group.settled),
      eligible: !!enabled && configured && group.settled >= 3 && group.taskIds.size >= 2,
    };
  });
  const recommendations = stages.flatMap((stage) => {
    const candidates = rows
      .filter((row) => row.stage === stage && row.eligible)
      .sort(
        (a, b) =>
          b.confidenceLower - a.confidenceLower ||
          (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity),
      );
    return candidates.length
      ? [
          {
            stage,
            harness: candidates[0].harness,
            model: candidates[0].model,
            samples: candidates[0].settled,
            alternatives: candidates.length,
            confidenceLower: candidates[0].confidenceLower,
          },
        ]
      : [];
  });
  return {
    repositoryId,
    rows,
    recommendations,
    minimumSamples: 3,
    minimumTasks: 2,
    notes:
      'Observational evidence, not a controlled comparison. Difficulty, task mix, reviewer strictness, configuration and provider defaults can affect results. Implementation success requires passing checks and clean review before the next implementation. Interrupted attempts are excluded. Unknown historical models are never recommended. No routing changes are automatic.',
  };
}
