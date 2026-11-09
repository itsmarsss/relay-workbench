import { workflowHealth, completionBrief, repositoryCoordination } from './workflow-insights.js';
import { e, icon, prose } from './ui.js';
const safeLink = (value) => {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
};
const concise = (value, max = 220) =>
  value.length > max ? value.slice(0, max).trimEnd() + '…' : value;
const disclosure = (label, count, content, key, hint = '') =>
  `<details class="result-disclosure" data-event-key="${key}"><summary><span class="result-row-label">${label}<span class="result-count">${count}</span></span>${hint ? `<span class="result-row-hint">${e(hint)}</span>` : ''}<span class="result-chevron">${icon('chevron')}</span></summary><div class="result-disclosure-body">${content}</div></details>`;
export function healthPanel(task) {
  const health = workflowHealth(task);
  if (!health.failures && !task.recovery?.active && !task.loopGuard) return '';
  const grouped = new Map();
  for (const run of health.evidence) {
    const item = grouped.get(run.summary);
    if (item) {
      item.count++;
      item.id = run.id;
    } else grouped.set(run.summary, { ...run, count: 1 });
  }
  const label = health.recovered ? 'Run history' : 'Workflow health';
  const status = health.recovered
    ? 'Recovered'
    : health.state === 'recovering'
      ? 'Recovering'
      : health.state === 'attention'
        ? 'Needs you'
        : 'History';
  return `<details class="productivity-panel health-panel" data-event-key="workflow-health"><summary><span class="history-heading"><span class="result-chevron">${icon('chevron')}</span><strong>${label}</strong><span class="history-count">${health.failures} failed runs · ${health.debugging} debug runs</span></span><span class="result-state ${health.recovered ? 'is-positive' : ''}">${e(status)}</span></summary><div class="history-body">${!health.recovered ? `<p class="history-explanation">${e(health.summary)}</p>` : ''}${health.strategy ? `<p class="history-explanation">${e(concise(health.strategy))}</p>` : ''}<div class="history-list-label">Recent failures</div><ul class="history-runs">${[
    ...grouped.values(),
  ]
    .slice(-3)
    .map(
      (r) =>
        `<li><button type="button" class="history-run" data-action="open-health-run" data-run="${e(r.id)}"><span class="history-run-copy">${e(concise(r.summary, 160))}</span>${r.count > 1 ? `<span class="result-count">×${r.count}</span>` : ''}<span class="history-run-open">View run ${icon('arrow')}</span></button></li>`,
    )
    .join(
      '',
    )}</ul><div class="history-footer"><button class="btn text small" data-action="tab" data-tab="thread">All activity ${icon('arrow')}</button></div></div></details>`;
}
export function completionPanel(task) {
  if (!['awaiting_final', 'completed'].includes(task.status)) return '';
  const result = completionBrief(task);
  const checks = result.checks
    .map(
      (c) =>
        `<li class="result-check"><span>${e(c.name || c.summary || [c.command, ...(c.args ?? [])].filter(Boolean).join(' ') || 'Check')}</span><span class="check-outcome ${c.code === 0 ? 'is-positive' : ''}">${c.code === 0 ? 'Passed' : c.code === undefined ? 'See report' : 'Failed'}</span></li>`,
    )
    .join('');
  return `<section class="productivity-panel completion-brief" aria-label="Completion brief"><header class="result-header"><div class="result-heading"><span class="result-mark">${icon('check')}</span><h2>${result.investigationOnly ? 'Findings' : 'Result'}</h2></div><span class="result-state ${task.status === 'completed' ? 'is-positive' : ''}">${task.status === 'completed' ? 'Accepted' : 'Ready for review'}</span></header><p class="result-summary">${e(concise(result.summary, 260))}</p>${!result.investigationOnly ? `<div class="result-gates"><span>${icon(result.verified ? 'check' : 'clock')}${result.verified ? 'Verified' : 'Verification pending'}</span><span>${icon(result.reviewed ? 'check' : 'clock')}${result.reviewed ? 'Reviewed' : 'Review pending'}</span></div>` : ''}<div class="result-evidence">${result.checks.length ? disclosure('Checks', result.checks.length, `<ul class="result-checks">${checks}</ul>`, 'completion-checks', result.checks.every((c) => c.code === 0) ? 'All passed' : 'View outcomes') : ''}${result.risks.length ? disclosure('Notes', result.risks.length, `<ul class="result-notes">${result.risks.map((r) => `<li>${e(r)}</li>`).join('')}</ul>`, 'completion-risks') : ''}</div><footer class="result-footer"><button class="btn secondary small" data-action="tab" data-tab="diff">${icon('code')}View changes</button><button class="btn text small" data-action="tab" data-tab="handoffs">Full reports ${icon('arrow')}</button></footer></section>`;
}
export function coordinationPanel(task) {
  const rows = repositoryCoordination(task);
  if (rows.length < 2) return '';
  return `<section class="productivity-panel coordination-panel" aria-label="Repository coordination"><header><h2>Repository coordination</h2><span class="detail-muted">${rows.length} repositories · shared approval</span></header><ol>${rows.map((row) => `<li><div><strong>${e(row.name)}</strong><span class="detail-muted">${row.implemented ? 'Implemented' : 'Implementation pending'}</span></div><p>${row.prerequisites.length ? `Implement after ${e(row.prerequisites.join(', '))}. ${row.waiting.length ? `Land after ${e(row.waiting.join(', '))}.` : 'Prerequisites merged.'}` : 'No repository prerequisites.'}</p>${safeLink(row.publication?.url) ? `<a href="${e(safeLink(row.publication.url))}" target="_blank" rel="noopener noreferrer">${e(row.publication.title || 'Pull request')} ↗</a>` : ''}</li>`).join('')}</ol><small>One verification gate covers all workspaces. Publication can open dependent PRs; merging is always manual.</small></section>`;
}
export function inboxDecisionDetails(item) {
  const brief = item.brief;
  if (!brief) return '';
  return `<p class="inbox-recommendation"><strong>Next step</strong> ${e(brief.recommendation)}</p>${brief.tried.length || brief.evidence.length ? `<details data-event-key="decision-evidence-${e(item.key)}"><summary>What was tried &amp; evidence</summary><ul>${[...brief.tried, ...brief.evidence].map((v) => `<li>${e(v)}</li>`).join('')}</ul></details>` : ''}${item.status === 'awaiting_final' ? `<button class="btn primary small" data-action="inbox-decide" data-id="${e(item.taskId)}" data-key="${e(item.key)}" data-operation="accept">Accept reviewed result</button>` : ''}${item.status === 'blocked' && brief.kind === 'runtime_budget' ? `<button class="btn primary small" data-action="inbox-decide" data-key="${e(item.key)}" data-operation="resume">Continue with more time</button>` : ''}${item.status === 'blocked' && brief.options.length ? `<div class="inbox-options">${brief.options.map((option) => `<article><h3>${e(option.title)}</h3><p>${e(option.description)}</p><p class="detail-muted">${e(option.tradeoffs)}</p><button class="btn secondary small" data-action="inbox-decide" data-key="${e(item.key)}" data-operation="resolve-blocker" data-option-id="${e(option.id)}" data-resolution="${option.id.startsWith('design-') ? 'replan' : 'retry'}">${option.id.startsWith('design-') ? 'Plan this direction' : 'Check this approach'}</button></article>`).join('')}</div>` : ''}${item.status === 'awaiting_plan' && brief.options.length ? `<div class="inbox-options">${brief.options.map((option, i) => `<article><h3>${e(option.title)}${i === 0 ? '<small>Recommended</small>' : ''}</h3><div class="prose">${prose(option.description)}</div>${option.tradeoffs ? `<details><summary>Tradeoffs</summary><div class="prose">${prose(option.tradeoffs)}</div></details>` : ''}<button class="btn ${i === 0 ? 'primary' : 'secondary'} small" data-action="inbox-decide" data-id="${e(item.taskId)}" data-key="${e(item.key)}" data-operation="approve-plan" data-option-id="${e(option.id)}">Choose approach</button></article>`).join('')}</div>` : ''}`;
}
