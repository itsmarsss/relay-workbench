import { escapeHTML } from './escape.js';
import { markdown } from './markdown.js';
export { escapeHTML };
export const e = escapeHTML;
const icons = {
  trash: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
  resize: '<path d="m8 20 12-12M14 20l6-6M20 20h.01"/>',
  orchestrator:
    '<rect x="8" y="3" width="8" height="6" rx="2"/><rect x="2" y="16" width="7" height="5" rx="1.5"/><rect x="15" y="16" width="7" height="5" rx="1.5"/><path d="M12 9v4H5.5v3M12 13h6.5v3"/>',
  move: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  relay: '<path d="M5 5h7a4 4 0 0 1 0 8H5V5Zm7 8 7 6M5 13v6M17 5h2v2"/>',
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
  publishing: 'Publishing',
  review: 'In review',
  draft: 'Backlog',
  queued: 'Queued',
  running: 'In progress',
  awaiting_plan: 'Choose an approach',
  awaiting_final: 'Final approval',
  completed: 'Done',
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
  const marks = {
    codex: '<rect x="2.5" y="3.5" width="19" height="17" rx="5"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    claude:
      Array.from(
        { length: 12 },
        (_, i) => `<path d="M12 3v5" transform="rotate(${i * 30} 12 12)"/>`,
      ).join('') + '<circle cx="12" cy="12" r="3"/>',
    pi: '<path d="M5 7h14M9 7v10m7-10v8c0 2 1 3 3 2"/><path d="M4 8c1-2 2-2 4-2"/>',
    checks: '<path d="m5 12 4 4L19 6"/>',
  };
  const name = { codex: 'Codex', claude: 'Claude', pi: 'Pi', checks: 'Checks' }[id] ?? id;
  return `<span class="harness-badge ${e(id)}" role="img" aria-label="${e(name)}" title="${e(name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${marks[id] ?? marks.checks}</svg></span>`;
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
export const prose = markdown;
export function empty(iconName, title, description, action = '') {
  return `<div class="empty-state">${icon(iconName, 'empty-icon')}<h3>${e(title)}</h3><p>${e(description)}</p>${action}</div>`;
}
