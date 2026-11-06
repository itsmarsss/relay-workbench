import { e, ago } from './ui.js';
import { concise } from './task-summary.js';
function safeURL(value) {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}
export function deliveryWorkflowStages(task) {
  if (task.demo) return '';
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  const publishing = entries.some(
    (r) => r.delivery?.status === 'running' || r.submission?.status === 'running',
  );
  const published = entries.every(
    (r) =>
      (r.delivery?.status === 'complete' && r.delivery?.phase === 'monitoring') ||
      ['open', 'closed', 'merged'].includes(r.publication?.state),
  );
  const monitoring = entries.some((r) => r.publicationMonitor?.enabled);
  return `<li class="${publishing ? 'current' : published ? 'done' : ''}"><span class="stage-number">${published ? '✓' : '7'}</span><div><strong>Publication</strong><small>${publishing ? 'Agent is publishing accepted changes' : published ? 'PR published' : task.status === 'completed' ? 'Ready for publication' : 'After final acceptance'}</small></div></li><li class="${monitoring ? 'current' : ''}"><span class="stage-number">8</span><div><strong>PR monitoring</strong><small>${monitoring ? 'Observing remote checks and reviews' : 'After publication'}</small></div></li>`;
}
export function publicationPanel(task) {
  if (!['awaiting_final', 'completed'].includes(task.status) || task.demo) return '';
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  return `<section class="publication-panel" aria-label="Commit and pull requests"><header class="publication-heading"><span class="eyebrow">DELIVERY</span><h2>${task.status === 'awaiting_final' ? 'Ready after acceptance' : 'From accepted changes to a PR'}</h2><p>${task.status === 'awaiting_final' ? 'Accept the code first. A publication agent can then commit and publish it.' : 'The publication agent handles committing and submitting. A separate agent keeps track of the PR.'}</p></header>${entries
    .map((entry) => {
      const id = e(entry.repository.id),
        submission = entry.submission,
        delivery = entry.delivery,
        pr = entry.publication,
        monitor = entry.publicationMonitor;
      const link = safeURL(pr?.url),
        hasPR = !!link && ['open', 'closed', 'merged'].includes(pr?.state);
      const publishing = delivery?.status === 'running' || submission?.status === 'running';
      const blocked =
        delivery?.status === 'blocked' ||
        delivery?.status === 'interrupted' ||
        (!hasPR && ['failed', 'interrupted'].includes(submission?.status));
      const state = publishing
        ? ({
            preparing: 'Preparing branch',
            verifying: 'Verifying branch',
            reviewing: 'Reviewing branch',
          }[delivery?.phase] ?? 'Publishing')
        : blocked
          ? 'Needs attention'
          : hasPR
            ? { open: pr.draft ? 'Draft PR' : 'Open PR', merged: 'Merged', closed: 'Closed' }[
                pr.state
              ]
            : monitor?.status === 'running'
              ? 'Finding PR'
              : 'Ready to publish';
      const summary = publishing
        ? delivery?.summary || 'Preparing the accepted commit and checking the provider.'
        : blocked
          ? delivery?.summary ||
            pr?.summary ||
            'The previous submission did not finish. A publication agent can inspect the cause and continue safely.'
          : pr?.summary ||
            (hasPR
              ? 'Remote PR confirmed.'
              : 'Your approval is saved. Publication has not completed.');
      return `<article class="publication-repository"><div class="publication-repo-heading"><h3>${e(entry.repository.name)}</h3><span class="badge ${blocked ? 'blocked' : ''}">${e(state)}</span></div><ol class="delivery-steps" aria-label="Delivery steps"><li class="done">Accepted</li><li class="${publishing || blocked ? 'current' : hasPR ? 'done' : ''}">Publish</li><li class="${monitor?.enabled && hasPR ? 'current' : ''}">Monitor</li></ol>${link ? `<a class="publication-link" href="${e(link)}" target="_blank" rel="noopener noreferrer">${e(pr.title || `Pull request ${pr.number || ''}`)} ↗</a>` : ''}<p class="delivery-summary">${e(concise(summary, 260))}</p>${delivery?.nextAction && blocked ? `<div class="delivery-next"><strong>Next step</strong><p>${e(concise(delivery.nextAction, 400))}</p></div>` : ''}${hasPR ? `<dl class="delivery-status"><div><dt>Checks</dt><dd>${e(pr.checks)}</dd></div><div><dt>Review</dt><dd>${e(pr.review.replaceAll('_', ' '))}</dd></div></dl>` : ''}${monitor?.error && !publishing ? `<p class="delivery-note">Latest remote status is unavailable. The last confirmed result is shown.</p>` : ''}${task.status === 'completed' ? `<div class="inline-actions">${publishing ? `<button class="btn secondary small" data-action="tab" data-tab="terminals">View live terminal</button>${delivery?.status === 'running' ? `<button class="btn text small" data-action="publication-pause" ${delivery.stopRequested ? 'disabled' : ''}>${delivery.stopRequested ? 'Stopping…' : 'Pause publication'}</button>` : ''}` : ''}${!publishing && !hasPR && (!delivery?.requiresReverification || delivery?.approvalBaseline) ? `<button class="btn primary small" data-action="confirm-submit" data-repository-id="${id}">${blocked ? 'Retry publication with agent' : 'Publish draft PR'}</button>` : ''}${!publishing ? `<button class="btn ${hasPR ? 'secondary' : 'text'} small" data-action="publication-monitor" data-repository-id="${id}" data-enabled="true" ${monitor?.status === 'running' ? 'disabled' : ''}>${monitor?.status === 'running' ? 'Checking status…' : hasPR ? 'Refresh PR status' : 'Find existing PR'}</button>${monitor?.enabled ? `<button class="btn text small" data-action="publication-monitor" data-repository-id="${id}" data-enabled="false">Pause monitoring</button>` : ''}` : ''}</div>` : ''}${delivery?.requiresReverification ? '<p class="delivery-note">Prepared work is preserved. Retrying resumes branch preparation and automatically verifies and reviews it before publishing.</p>' : ''}<small class="delivery-timestamp">${pr?.checkedAt ? `Last checked ${ago(pr.checkedAt).toLowerCase()}` : 'No confirmed remote snapshot yet'}${monitor?.enabled ? ' · Monitoring on' : ''}</small><button class="btn text small delivery-details-button" data-action="delivery-details" data-repository-id="${id}">View technical details</button></article>`;
    })
    .join('')}</section>`;
}

export function publicationDetails(task, repositoryId) {
  const entry = (task.repositories?.length > 1 ? task.repositories : [task]).find(
    (r) => r.repository.id === repositoryId,
  );
  if (!entry) return '<p>Repository not found.</p>';
  const delivery = entry.delivery,
    submission = entry.submission,
    pr = entry.publication,
    monitor = entry.publicationMonitor;
  const evidence = delivery?.evidence || pr?.evidence || [];
  return `<div class="delivery-detail-content"><h3>Branch and commit</h3><dl><dt>Repository</dt><dd>${e(entry.repository.name)}</dd><dt>Branch</dt><dd><code>${e(entry.branch || 'Not assigned')}</code></dd><dt>Commit</dt><dd><code>${e(delivery?.commit || submission?.commit || 'Not committed yet')}</code></dd></dl>${delivery?.details ? `<h3>Publication agent findings</h3><p>${e(delivery.details)}</p>` : ''}${monitor?.error ? `<h3>Latest observation</h3><p>${e(monitor.error)}</p>` : ''}${evidence.length ? `<h3>Evidence</h3><ul>${evidence.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : ''}${submission ? `<h3>Previous provider output</h3><pre class="delivery-provider-output">${e(submission.stdout || '')}${e(submission.stderr || submission.error || 'No output recorded.')}</pre>` : ''}</div>`;
}
