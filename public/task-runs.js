// Include legacy current delivery records without inventing lost historical runs.
export function taskRuns(task) {
  const runs = new Map((task.attempts ?? []).map((run) => [run.id ?? run, run]));
  for (const run of task.deliveryRuns ?? []) runs.set(run.id, run);
  for (const entry of task.repositories?.length > 1 ? task.repositories : [task]) {
    for (const [record, stage] of [
      [entry.delivery, 'publish'],
      [entry.publicationMonitor, 'monitor'],
    ]) {
      const id = record?.id ?? record?.attemptId;
      if (!id || !record.startedAt || runs.has(id)) continue;
      runs.set(id, {
        ...record,
        id,
        stage,
        repositoryId: entry.repository?.id,
        status:
          { idle: 'complete', unavailable: 'failed', paused: 'interrupted' }[record.status] ??
          record.status,
        handoff: {
          summary: record.summary || record.error || '',
          verdict: record.status === 'blocked' ? 'blocked' : undefined,
        },
      });
    }
  }
  return [...runs.values()].sort((a, b) =>
    a.startedAt && b.startedAt ? Date.parse(a.startedAt) - Date.parse(b.startedAt) : 0,
  );
}
