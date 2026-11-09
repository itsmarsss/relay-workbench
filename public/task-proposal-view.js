import { e, prose } from './ui.js';
export function taskProposalChange(change) {
  switch (change.operation) {
    case 'settings':
      return {
        operation: 'Edit task settings',
        ...change.settings,
        nextWorkflowState: change.effects,
      };
    case 'automation':
      return {
        operation: 'Auto mode',
        enabled: change.enabled,
        scope:
          change.scope === 'draft_pr'
            ? 'Accept verified/reviewed work and publish a draft PR'
            : 'Accept verified/reviewed work; publication stays manual',
      };
    case 'checkpoint':
      return {
        operation: 'Create a separate checkpoint continuation',
        checkpointId: change.checkpointId,
        continueAt: change.stage,
        direction: change.note || '',
        originalWork: 'Preserved; Auto and publication delegation are not inherited',
      };
    case 'workflow':
      return { operation: change.action, ...change.data };
    case 'publish':
      return {
        operation: 'Run publication agent',
        repositoryId: change.repositoryId,
        request: change.request || 'Publish accepted work',
      };
    case 'monitor':
      return {
        operation: 'PR monitoring',
        repositoryId: change.repositoryId,
        enabled: change.enabled,
      };
    case 'feedback':
      return {
        operation: 'PR feedback automation',
        repositoryId: change.repositoryId,
        enabled: change.enabled,
      };
    default:
      return { operation: change.operation };
  }
}

export function taskProposalPreview(change) {
  const proposed = taskProposalChange(change);
  const actions = {
    start: 'Start this workflow',
    resume: 'Resume the saved workflow',
    pause: 'Pause the workflow',
    cancel: 'Cancel the workflow and retain its files',
    debug: 'Run the debugger',
    'resolve-blocker': 'Apply the selected debugger decision',
    'request-changes': 'Request changes',
    'follow-up': 'Plan follow-up work',
    'approve-plan': 'Approve the selected implementation approach',
    accept: 'Accept the reviewed result',
  };
  let summary,
    detail = '',
    current = '';
  switch (change.operation) {
    case 'automation':
      summary = change.enabled ? 'Turn Auto on' : 'Turn Auto off';
      detail = change.enabled
        ? proposed.scope
        : 'Subsequent decisions wait for you. Already-running work continues.';
      current = change.before?.enabled ? 'Auto on' : 'Auto off';
      break;
    case 'checkpoint':
      summary = 'Create a separate checkpoint continuation';
      detail = {
        saved: 'Continue at the saved next step.',
        approach: 'Reopen saved implementation choices without repeating investigation.',
        decision: 'Revisit the saved debugger decision.',
        plan: 'Write a new plan using the saved investigation.',
        implement: 'Continue the approved implementation.',
        verify: 'Run fresh verification.',
      }[change.stage];
      current =
        'Original workflow and files stay intact. Auto and publication permissions are not inherited.';
      break;
    case 'workflow':
      summary = actions[change.action];
      detail = change.before?.selectedOption
        ? change.before.selectedOption.title
        : change.data?.note || change.data?.message || '';
      if (change.action === 'resolve-blocker')
        detail = `Resolution: ${change.data.resolution}${change.data.optionId ? ` · ${change.before?.blocker?.options?.find((option) => option.id === change.data.optionId)?.title || change.data.optionId}` : ''}`;
      current = `Current stage: ${change.before?.stage || 'unknown'} · ${change.before?.status || 'unknown'}`;
      break;
    case 'settings':
      summary = 'Update task settings';
      detail = Object.keys(change.settings)
        .map(
          (key) =>
            ({
              routing: 'Agents',
              models: 'Models',
              execution: 'Execution limits',
              repositorySettings: 'Repository settings',
              preset: 'Workflow preset',
            })[key] || key,
        )
        .join(', ');
      current = change.effects?.approachApprovalReset
        ? 'Scope changes require a fresh investigation and approach approval.'
        : change.effects?.status === 'paused'
          ? 'The workflow stays paused until resumed.'
          : '';
      break;
    case 'publish':
      summary = 'Run the publication agent';
      detail =
        change.request ||
        'Commit and publish accepted work using the configured repository provider.';
      break;
    case 'monitor':
      summary = change.enabled ? 'Watch PR status' : 'Stop watching PR status';
      detail = 'Applies to the selected repository.';
      break;
    case 'feedback':
      summary = change.enabled ? 'Enable PR feedback automation' : 'Disable PR feedback automation';
      detail = 'Applies to the selected repository.';
      break;
  }
  return `<section><h3>${e(change.title)}</h3><p><strong>${e(summary || proposed.operation)}</strong></p>${detail ? `<div class="prose">${prose(detail)}</div>` : ''}${current ? `<p class="form-help">${e(current)}</p>` : ''}${change.note ? `<p>${e(change.note)}</p>` : ''}<details class="detail-disclosure"><summary>Exact settings and context</summary><strong>Current</strong><pre class="code-block">${e(JSON.stringify(change.before, null, 2))}</pre><strong>Proposed</strong><pre class="code-block">${e(JSON.stringify(proposed, null, 2))}</pre></details></section>`;
}
