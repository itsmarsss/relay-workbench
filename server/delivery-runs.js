// Auxiliary agents have their own history so they cannot advance development stages.
export function saveDeliveryRun(task, entry, stage) {
  const record = stage === 'publish' ? entry.delivery : entry.publicationMonitor;
  const id = record?.id ?? record?.attemptId;
  if (!id || !record.startedAt) return;
  task.deliveryRuns ??= [];
  const index = task.deliveryRuns.findIndex((run) => run.id === id);
  const old = task.deliveryRuns[index];
  const status =
    { idle: 'complete', unavailable: 'failed', paused: 'interrupted' }[record.status] ??
    record.status;
  const run = {
    ...structuredClone(record),
    id,
    stage: record.stage ?? stage,
    auxiliary: true,
    status,
    repositoryId: entry.repository.id,
    parentAttemptId: old
      ? old.parentAttemptId
      : (task.deliveryRuns.findLast((run) => run.id !== id)?.id ?? task.attempts?.at(-1)?.id),
    relation: stage === 'publish' ? 'Publication' : 'PR observation',
    handoff: {
      verdict: status === 'complete' ? 'complete' : status === 'running' ? 'running' : 'blocked',
      summary: record.summary || record.error || '',
      details: record.details || record.error || '',
      evidence: record.evidence ?? [],
      risks: record.nextAction ? [record.nextAction] : [],
    },
  };
  if (index < 0) task.deliveryRuns.push(run);
  else task.deliveryRuns[index] = run;
}

// Older releases kept agent events but only the latest delivery record.
export function recoverDeliveryRuns(task, events, entries) {
  const before = JSON.stringify(task.deliveryRuns ?? []);
  task.deliveryRuns ??= [];
  for (const event of events) {
    if (!['publish', 'monitor'].includes(event.stage) || !event.attemptId) continue;
    if (task.deliveryRuns.some((run) => run.id === event.attemptId)) continue;
    task.deliveryRuns.push({
      id: event.attemptId,
      stage: event.stage,
      harness: event.harness || 'unknown',
      repositoryId: event.repositoryId,
      startedAt: event.at,
      status: 'recorded',
      recovered: true,
      handoff: { summary: 'Recovered agent activity. The original outcome was not retained.' },
    });
  }
  for (const entry of entries) {
    for (const stage of ['publish', 'monitor']) {
      const record = stage === 'publish' ? entry.delivery : entry.publicationMonitor;
      const id = record?.id ?? record?.attemptId;
      if (!id) continue;
      const existing = task.deliveryRuns.find((run) => run.id === id);
      if (!existing || existing.recovered || record.status === 'interrupted')
        saveDeliveryRun(task, entry, stage);
    }
  }
  task.deliveryRuns.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return before !== JSON.stringify(task.deliveryRuns);
}
