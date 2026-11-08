import { e } from './ui.js';
export function inboxPage(items) {
  return `<div class="page-heading"><div><span class="eyebrow">DECISIONS</span><h1>Approval inbox</h1><p>${items.length ? `${items.length} ${items.length === 1 ? 'task needs' : 'tasks need'} your input.` : 'You’re all caught up.'}</p></div><button class="btn secondary" data-action="enable-notifications">${localStorage.getItem('relay-notifications') === 'enabled' ? 'Disable desktop notifications' : 'Enable desktop notifications'}</button></div><div class="inbox-list">${items.map((item) => `<article class="inbox-card ${item.seen ? 'is-seen' : ''}" data-event-key="inbox-${e(item.key)}"><div class="inbox-card-copy"><div class="inbox-card-meta"><span>${e(item.action)}</span>${!item.seen ? '<span class="inbox-new">New</span>' : '<span class="detail-muted">Seen</span>'}</div><h2>${e(item.title)}</h2><p>${e(item.summary)}</p></div><div class="inbox-card-actions"><button class="btn primary small" data-action="inbox-open" data-id="${e(item.taskId)}" data-key="${e(item.key)}">Open task ↗</button>${!item.seen ? `<button class="btn text small" data-action="inbox-seen" data-key="${e(item.key)}">Mark seen</button>` : ''}</div></article>`).join('') || '<div class="workspace-empty"><h2>No decisions waiting</h2><p>Approvals and blockers appear here when an agent needs you.</p><button class="btn secondary" data-action="navigate" data-view="tasks">View tasks</button></div>'}</div>`;
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
