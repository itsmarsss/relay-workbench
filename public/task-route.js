export const taskTabs = ['overview', 'thread', 'terminals', 'handoffs', 'diff', 'transcript'];
export function taskRoute(id, tab = 'overview', sideChatOpen = false) {
  return `#task/${id}/${taskTabs.includes(tab) ? tab : 'overview'}${sideChatOpen ? '?chat=1' : ''}`;
}
export function parseTaskRoute(hash) {
  const [path, query] = hash.replace(/^#/, '').split('?');
  const match = path.match(/^task\/([a-f0-9-]+)(?:\/([a-z]+))?$/);
  return match
    ? {
        id: match[1],
        tab: taskTabs.includes(match[2]) ? match[2] : 'overview',
        ...(new URLSearchParams(query).get('chat') === '1' ? { sideChatOpen: true } : {}),
      }
    : null;
}
