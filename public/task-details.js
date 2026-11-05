import { e, icon, prose } from './ui.js';

export function issueLink(ticket) {
  const value = String(ticket ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Unsupported issue URL');
    const issue = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
    const label =
      url.hostname === 'github.com' && issue
        ? `GitHub · ${issue[1]}/${issue[2]}#${issue[3]}`
        : value;
    return `<a class="issue-link" href="${e(url.href)}" target="_blank" rel="noopener noreferrer">${e(label)} ${icon('arrow')}</a>`;
  } catch {
    return `<span class="ticket-reference">${e(value)}</span>`;
  }
}

export function taskDetails(task) {
  if (!task.description && !task.ticket) return '';
  return `<section class="task-details" aria-label="Task description"><div class="context-title">DESCRIPTION &amp; REQUIREMENTS ${icon('book')}</div>${task.description ? `<div id="task-description" class="prose task-description" tabindex="0" role="region" aria-label="Description and requirements">${prose(task.description)}</div>` : '<p class="muted">No description provided.</p>'}</section>`;
}
