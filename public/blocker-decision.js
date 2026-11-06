import { e } from './ui.js';
import { concise } from './task-summary.js';
export function blockerDecisionView(task) {
  if (task.status !== 'blocked') return '';
  if (task.blockerDecision?.kind === 'runtime_budget')
    return `<section class="blocker-decision" aria-label="Execution time budget"><span class="eyebrow">MORE TIME NEEDED</span><h2>The stage reached its time budget</h2><p>Completed checks and logs are preserved. A timeout does not establish a test failure. Resume to continue with a new bounded budget, or inspect the latest output first.</p><button class="btn primary" data-action="task-action" data-operation="resume">Continue with more time</button><button class="btn secondary" data-action="tab" data-tab="transcript">Inspect execution log</button></section>`;
  if (task.blockerDecision?.kind === 'verification_report') {
    const recovering = task.verificationReportRepair?.mode === 'check_recovery';
    return `<section class="blocker-decision" aria-label="Verification report correction"><h2>${recovering ? 'A failed check still needs resolution' : 'Checks are preserved; the report needs correction'}</h2><p>${e(task.blockerDecision.explanation)}</p><button class="btn primary" data-action="task-action" data-operation="resume">${recovering ? 'Continue verifier recovery' : 'Retry report correction'}</button></section>`;
  }
  const trusted =
    task.stage === 'implement' && task.chosenApproach
      ? '<button class="btn secondary" data-action="task-action" data-operation="verify-blocker">Run verification &amp; continue</button>'
      : '';
  const decision = task.blockerDecision;
  if (!decision || decision.resolved)
    return `<section class="blocker-decision"><h2>Let a debugger investigate</h2><p>A dedicated agent can inspect this blocker and bring back a specific decision if it needs you.</p><button class="btn primary" data-action="task-action" data-operation="debug">Run debugger</button>${trusted}</section>`;
  const action = (resolution, label, optionId = '') =>
    `<button class="btn ${resolution === 'retry' ? 'primary' : 'secondary'}" data-action="resolve-blocker" data-decision-id="${e(decision.id)}" data-resolution="${resolution}" ${optionId ? `data-option-id="${e(optionId)}"` : ''}>${label}</button>`;
  return `<section class="blocker-decision" aria-label="Blocker decision"><span class="eyebrow">YOUR DECISION</span><h2>Choose how to continue</h2><p class="blocker-summary">${e(concise(decision.summary, 320))}</p><p>Automation is paused. Choose a direction; the approved scope stays in effect.</p>${
    decision.required.length
      ? `<h3>What needs your input</h3><ul>${decision.required
          .slice(0, 2)
          .map((value) => `<li>${e(concise(value, 220))}</li>`)
          .join('')}</ul>`
      : ''
  }${decision.evidence.length || decision.required.length ? `<details data-event-key="blocker-evidence"><summary>Full requirements &amp; evidence</summary><h3>Requirements</h3><ul>${decision.required.map((value) => `<li>${e(value)}</li>`).join('')}</ul><ul>${decision.evidence.map((value) => `<li>${e(value)}</li>`).join('')}</ul><p>${e(decision.explanation)}</p></details>` : `<p>${e(decision.explanation)}</p>`}${decision.options.length ? `<div class="blocker-options">${decision.options.map((option) => `<article><h3>${e(option.title)}</h3><p>${e(option.description)}</p><p class="muted">${e(option.tradeoffs)}</p>${action(option.id.startsWith('design-') ? 'replan' : 'retry', option.id.startsWith('design-') ? 'Plan this direction' : 'Ask debugger to check this', option.id)}</article>`).join('')}</div>` : ''}<div class="inline-actions">${trusted}${action('retry', 'Retry debugger')}${action('replan', 'Revise approach')}${action('pause', 'Pause task')}</div><p class="form-help">Direction goes to the debugger. Revising the approach requires new implementation approval.</p></section>`;
}
