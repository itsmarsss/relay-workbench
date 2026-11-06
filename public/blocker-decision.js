import { e } from './ui.js';
import { concise } from './task-summary.js';
export function blockerDecisionView(task) {
  if (task.status !== 'blocked') return '';
  const trusted =
    task.stage === 'implement' && task.chosenApproach
      ? '<button class="btn secondary" data-action="task-action" data-operation="verify-blocker">Run host checks &amp; continue</button>'
      : '';
  const decision = task.blockerDecision;
  if (!decision || decision.resolved)
    return `<section class="blocker-decision"><h2>Let a debugger investigate</h2><p>A dedicated agent can inspect this blocker and bring back a specific decision if it needs you.</p><button class="btn primary" data-action="task-action" data-operation="debug">Run debugger</button>${trusted}</section>`;
  const action = (resolution, label, optionId = '') =>
    `<button class="btn ${resolution === 'retry' ? 'primary' : 'secondary'}" data-action="resolve-blocker" data-decision-id="${e(decision.id)}" data-resolution="${resolution}" ${optionId ? `data-option-id="${e(optionId)}"` : ''}>${label}</button>`;
  return `<section class="blocker-decision" aria-label="Blocker decision"><span class="eyebrow">YOUR DECISION</span><h2>Help the debugger move forward</h2><p class="blocker-summary">${e(concise(decision.summary, 320))}</p><p>${decision.debugAttempts ? `${decision.debugAttempts} diagnostic ${decision.debugAttempts === 1 ? 'attempt has' : 'attempts have'} finished.` : 'Automatic diagnosis is unavailable or disabled.'} Choose a direction below.</p>${
    decision.required.length
      ? `<h3>What needs your input</h3><ul>${decision.required
          .slice(0, 3)
          .map((value) => `<li>${e(concise(value, 360))}</li>`)
          .join('')}</ul>`
      : ''
  }${decision.evidence.length ? `<details data-event-key="blocker-evidence"><summary>What was tried &amp; evidence (${decision.evidence.length})</summary><ul>${decision.evidence.map((value) => `<li>${e(value)}</li>`).join('')}</ul><p>${e(decision.explanation)}</p></details>` : `<p>${e(decision.explanation)}</p>`}${decision.options.length ? `<div class="blocker-options">${decision.options.map((option) => `<article><h3>${e(option.title)}</h3><p>${e(option.description)}</p><p class="muted">${e(option.tradeoffs)}</p>${action(option.id.startsWith('design-') ? 'replan' : 'retry', option.id.startsWith('design-') ? 'Plan this direction' : 'Ask debugger to check this', option.id)}</article>`).join('')}</div>` : ''}<div class="inline-actions">${trusted}${action('retry', 'Retry debugger')}${action('replan', 'Revise approach')}${action('pause', 'Pause task')}</div><p class="form-help">Direction goes to the debugger. Revising the approach requires new implementation approval.</p></section>`;
}
