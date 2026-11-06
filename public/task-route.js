export const taskTabs = ['overview', 'thread', 'terminals', 'handoffs', 'diff', 'transcript'];
export function taskRoute(id, tab = 'overview') {
  return `#task/${id}/${taskTabs.includes(tab) ? tab : 'overview'}`;
}
export function parseTaskRoute(hash) {
  const match = hash.replace(/^#/, '').match(/^task\/([a-f0-9-]+)(?:\/([a-z]+))?$/);
  return match ? { id: match[1], tab: taskTabs.includes(match[2]) ? match[2] : 'overview' } : null;
}
