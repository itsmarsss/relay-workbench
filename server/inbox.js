const labels = {
  awaiting_plan: 'Choose an approach',
  awaiting_final: 'Review and accept',
  blocked: 'Resolve a blocker',
  interrupted: 'Inspect interrupted work',
  manual: 'Return control when ready',
};
export function inbox(store) {
  return store
    .all()
    .filter((task) => labels[task.status])
    .map((task) => {
      const event = store.db
        .prepare(
          "SELECT seq FROM events WHERE task_id=? AND json_extract(body, '$.type') IN ('decision','blocked','interrupted','manual','approval','stage_completed') ORDER BY seq DESC LIMIT 1",
        )
        .get(task.id);
      const key = `${task.id}:${task.status}:${event?.seq ?? 0}`;
      const seen = !!store.db.prepare('SELECT value FROM meta WHERE key=?').get(`seen:${key}`);
      return {
        key,
        taskId: task.id,
        title: task.title,
        status: task.status,
        action: labels[task.status],
        summary: task.error || task.attempts.findLast((a) => a.handoff)?.handoff.summary || '',
        updatedAt: task.updatedAt,
        seen,
      };
    });
}
export function acknowledge(store, key) {
  if (!inbox(store).some((item) => item.key === key)) return false;
  store.db
    .prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)')
    .run(`seen:${key}`, new Date().toISOString());
  return true;
}
