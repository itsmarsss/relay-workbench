import { inboxDecisionDetails } from './productivity.js';
import { e } from './ui.js';
export function inboxPage(items) {
  return `<div class="page-heading"><div><span class="eyebrow">DECISIONS</span><h1>Approval inbox</h1><p>${items.length ? `${items.length} ${items.length === 1 ? 'task needs' : 'tasks need'} your input.` : 'You’re all caught up.'}</p></div><button class="btn secondary" data-action="enable-notifications">${localStorage.getItem('relay-notifications') === 'enabled' ? 'Disable desktop notifications' : 'Enable desktop notifications'}</button></div><div class="inbox-list">${items.map((item) => `<article class="inbox-card ${item.seen ? 'is-seen' : ''}" data-event-key="inbox-${e(item.key)}"><div class="inbox-card-copy"><div class="inbox-card-meta"><span>${e(item.action)}</span>${!item.seen ? '<span class="inbox-new">New</span>' : '<span class="detail-muted">Seen</span>'}</div><h2>${e(item.title)}</h2><p>${e(item.summary)}</p>${inboxDecisionDetails(item)}</div><div class="inbox-card-actions"><button class="btn primary small" data-action="inbox-open" data-id="${e(item.taskId)}" data-key="${e(item.key)}">Open task ↗</button>${!item.seen ? `<button class="btn text small" data-action="inbox-seen" data-key="${e(item.key)}">Mark seen</button>` : ''}</div></article>`).join('') || '<div class="workspace-empty"><h2>No decisions waiting</h2><p>Approvals and blockers appear here when an agent needs you.</p><button class="btn secondary" data-action="navigate" data-view="tasks">View tasks</button></div>'}</div>`;
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
        location.hash = `task/${item.taskId}/overview`;
        notification.close();
      };
      notified.add(item.key);
    }
  }
  localStorage.setItem('relay-notified', JSON.stringify([...notified].slice(-1000)));
}

let taskStates;
export function notifyResults(tasks) {
  const current = new Map(
    tasks.map((task) => [task.id, `${task.status}:${task.approvals?.length ?? task.updatedAt}`]),
  );
  if (!taskStates) {
    taskStates = current;
    return;
  }
  const enabled =
    localStorage.getItem('relay-notifications') === 'enabled' &&
    'Notification' in window &&
    Notification.permission === 'granted';
  for (const task of tasks) {
    if (
      !enabled ||
      task.status !== 'completed' ||
      !taskStates.has(task.id) ||
      taskStates.get(task.id) === current.get(task.id)
    )
      continue;
    // Completion transitions only; monitoring updates must never produce another notification.
    if (taskStates.get(task.id).startsWith('completed:')) continue;
    const receipt = `relay-result:${task.id}:${task.followUpContext?.id ?? task.createdAt ?? 'initial'}`;
    if (localStorage.getItem(receipt)) continue;
    localStorage.setItem(receipt, 'sent');
    const notification = new Notification(
      task.preset === 'investigate' ? 'Investigation complete' : 'Result accepted',
      { body: task.title, tag: `complete-${task.id}` },
    );
    notification.onclick = () => {
      window.focus();
      location.hash = `task/${task.id}/overview`;
      notification.close();
    };
  }
  taskStates = current;
}
