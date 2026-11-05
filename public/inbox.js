import { e } from './ui.js';
export function inboxPage(items) {
  return `<div class="page-heading"><div><h1>Approval inbox</h1><p>Open a task to inspect evidence and make a decision. Seen items remain here until resolved.</p></div><button class="btn secondary" data-action="enable-notifications">${localStorage.getItem('relay-notifications') === 'enabled' ? 'Disable desktop notifications' : 'Enable desktop notifications'}</button></div><div class="task-table">${items.map((item) => `<article class="context-card"><strong>${e(item.action)}${item.seen ? '' : ' · New'}</strong><h2>${e(item.title)}</h2><p>${e(item.summary)}</p><button class="btn primary" data-action="inbox-open" data-id="${e(item.taskId)}" data-key="${e(item.key)}">Open task</button>${!item.seen ? `<button class="btn text" data-action="inbox-seen" data-key="${e(item.key)}">Mark seen</button>` : ''}</article>`).join('') || '<p class="context-card">No decisions waiting. Agents will stop here when your input is needed.</p>'}</div>`;
}
export function notifyInbox(items) {
  if (
    localStorage.getItem('relay-notifications') !== 'enabled' ||
    !('Notification' in window) ||
    Notification.permission !== 'granted'
  )
    return;
  let notified;
  try {
    notified = new Set(JSON.parse(localStorage.getItem('relay-notified') || '[]'));
  } catch {
    notified = new Set();
  }
  for (const item of items) {
    if (!item.seen && !notified.has(item.key)) {
      const notification = new Notification(item.action, { body: item.title, tag: item.key });
      notification.onclick = () => {
        window.focus();
        location.hash = `task/${item.taskId}`;
        notification.close();
      };
      notified.add(item.key);
    }
  }
  localStorage.setItem('relay-notified', JSON.stringify([...notified].slice(-1000)));
}
