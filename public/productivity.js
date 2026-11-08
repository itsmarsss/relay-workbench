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
export function healthPanel(task) {
  const health = workflowHealth(task);
  if (!health.failures && !task.recovery?.active && !task.loopGuard) return '';
  const grouped = new Map();
  for (const run of health.evidence) {
    const item = grouped.get(run.summary);
    if (item) item.count++;
    else grouped.set(run.summary, { ...run, count: 1 });
  }
  return `<details class="productivity-panel health-panel" data-event-key="workflow-health"><summary><span>${icon(health.recovered ? 'check' : 'clock')}${health.recovered ? 'Run history' : 'Workflow health'}</span><span class="detail-muted">${health.recovered ? 'Recovered' : health.state === 'recovering' ? 'Recovering' : health.state === 'attention' ? 'Needs you' : 'View history'}</span></summary><p>${e(health.summary)}</p><small class="detail-muted">${health.failures} past failures · ${health.debugging} debug runs</small>${health.strategy ? `<p>${e(concise(health.strategy))}</p>` : ''}<ul class="brief-evidence">${[...grouped.values()].map((r) => `<li><span>${e(concise(r.summary, 180))}${r.count > 1 ? ` ×${r.count}` : ''}</span><button class="btn text small" data-action="open-health-run" data-run="${e(r.id)}">View run</button></li>`).join('')}</ul><button class="btn text small" data-action="tab" data-tab="thread">All activity</button></details>`;
}
export function completionPanel(task) {
  if (!['awaiting_final', 'completed'].includes(task.status)) return '';
  const result = completionBrief(task);
  return `<section class="productivity-panel completion-brief" aria-label="Completion brief"><header><h2>${result.investigationOnly ? 'Findings' : 'Result'}</h2><span class="detail-muted">${task.status === 'completed' ? 'Accepted' : 'Ready for review'}</span></header><p>${e(concise(result.summary, 260))}</p>${!result.investigationOnly ? `<div class="brief-signals"><span>${icon(result.verified ? 'check' : 'clock')}${result.verified ? 'Verified' : 'Verification not recorded'}</span><span>${icon(result.reviewed ? 'check' : 'clock')}${result.reviewed ? 'Reviewed' : 'Review not recorded'}</span></div>` : ''}${result.checks.length ? `<details data-event-key="completion-checks"><summary>${result.checks.length} recorded checks</summary><ul>${result.checks.map((c) => `<li><strong>${e(c.name || c.summary || [c.command, ...(c.args ?? [])].filter(Boolean).join(' ') || 'Check')}</strong> · ${c.code === 0 ? 'Passed' : c.code === undefined ? 'See report' : 'Failed'}</li>`).join('')}</ul></details>` : ''}${result.risks.length ? `<details data-event-key="completion-risks"><summary>${result.risks.length} reported notes</summary><ul>${result.risks.map((r) => `<li>${e(concise(r, 240))}</li>`).join('')}</ul></details>` : ''}<div class="inline-actions"><button class="btn text small" data-action="tab" data-tab="diff">Changes</button><button class="btn text small" data-action="tab" data-tab="handoffs">Full reports</button></div></section>`;
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
