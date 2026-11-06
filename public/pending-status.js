import { overrideStatuses } from './task-status.js';
// Keep editing available while an older server finishes an active agent run.
export function statusQueue(storage) {
  const key = 'relay-pending-status-overrides';
  let values = {};
  try {
    const raw = JSON.parse(storage.getItem(key) || '{}');
    for (const [id, entry] of Object.entries(raw))
      if (entry && (entry.value === null || Object.hasOwn(overrideStatuses, entry.value)))
        values[id] = entry;
  } catch {}
  const persist = () => storage.setItem(key, JSON.stringify(values));
  let nextSync = 0;
  return {
    set(id, value) {
      values[id] = { value, at: new Date().toISOString() };
      persist();
      nextSync = 0;
    },
    clear(id) {
      delete values[id];
      persist();
    },
    apply(task) {
      if (!Object.hasOwn(values, task.id)) return task;
      const entry = values[task.id];
      return { ...task, statusOverride: entry.value === null ? null : { ...entry, pending: true } };
    },
    async sync(api, now = Date.now()) {
      if (now < nextSync) return;
      nextSync = now + 30000;
      for (const [id, entry] of Object.entries(values)) {
        try {
          await api(`/tasks/${id}/status-override`, 'POST', { value: entry.value });
          if (values[id] === entry) {
            delete values[id];
            persist();
          }
        } catch {
          break;
        }
      }
    },
  };
}
