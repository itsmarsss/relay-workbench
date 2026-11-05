export const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const e = escapeHTML;
const icons = {
  relay: '<path d="M4 4h10a5 5 0 0 1 0 10H9l-5 5V4Z"/><path d="M9 9v5m4-5h2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-3h6a6 6 0 0 0 6-6"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-5 3 2-18"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"/>',
  book: '<path d="M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3V4Zm9 2v16"/>',
};
export function icon(name, className = '') {
  return `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.bolt}</svg>`;
}
export const stageNames = {
  triage: 'Triage',
  investigate: 'Investigation',
  plan: 'Solution design',
  implement: 'Implementation',
  verify: 'Verification',
  review: 'Independent review',
};
export const statusNames = {
  draft: 'Ready to start',
  queued: 'Queued',
  running: 'In progress',
  awaiting_plan: 'Choose an approach',
  awaiting_final: 'Final review',
  completed: 'Completed',
  paused: 'Paused',
  manual: 'Manual control',
  blocked: 'Needs attention',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};
export function badge(status) {
  return `<span class="badge ${e(status)}"><span class="status-dot"></span>${e(statusNames[status] || status)}</span>`;
}
export function harnessBadge(id) {
  return `<span class="harness-badge ${e(id)}">${id === 'codex' ? 'C' : id === 'claude' ? '✳' : id === 'pi' ? 'π' : '✓'}</span>`;
}
export function duration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export function ago(value) {
  const min = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  return min < 1
    ? 'Just now'
    : min < 60
      ? `${min}m ago`
      : min < 1440
        ? `${Math.floor(min / 60)}h ago`
        : new Date(value).toLocaleDateString();
}
export function prose(value) {
  return String(value ?? '')
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith('```')
        ? `<pre class="code-block">${e(part.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))}</pre>`
        : part
            .split('\n\n')
            .map(
              (p) =>
                `<p>${e(p)
                  .replace(/\n/g, '<br>')
                  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                  .replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`,
            )
            .join(''),
    )
    .join('');
}
export function empty(iconName, title, description, action = '') {
  return `<div class="empty-state">${icon(iconName, 'empty-icon')}<h3>${e(title)}</h3><p>${e(description)}</p>${action}</div>`;
}
