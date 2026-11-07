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
  return `<li class="${publishing ? 'current' : published ? 'done' : ''}"><span class="stage-number">${published ? '✓' : '7'}</span><div><strong>Publish</strong><small>${publishing ? 'Agent is publishing accepted changes' : published ? 'PR published' : task.status === 'completed' ? 'Ready for publication' : 'After final acceptance'}</small></div></li>`;
}
export function publicationPanel(task) {
  if (task.status !== 'completed' || task.demo) return '';
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  return `<section class="pr-tracker" aria-label="Pull requests">${entries
    .map((entry) => {
      const id = e(entry.repository.id),
        pr = entry.publication,
        delivery = entry.delivery,
        monitor = entry.publicationMonitor;
      const link = safeURL(pr?.url),
        hasPR = link && ['open', 'closed', 'merged'].includes(pr?.state);
      const running = delivery?.status === 'running' || entry.submission?.status === 'running';
      const blocked =
        !running &&
        (['blocked', 'interrupted'].includes(delivery?.status) ||
          (!hasPR && ['failed', 'interrupted'].includes(entry.submission?.status)));
      const label = running
        ? 'Publishing…'
        : blocked
          ? 'Publishing needs attention'
          : hasPR
            ? { open: pr.draft ? 'Draft PR' : 'Open PR', merged: 'Merged', closed: 'Closed' }[
                pr.state
              ]
            : 'Not published';
      return `<div class="pr-tracker-row"><div class="pr-tracker-state"><strong>${entries.length > 1 ? e(entry.repository.name) : 'Pull request'}</strong><span class="badge ${blocked ? 'blocked' : running ? 'running' : ''}">${e(label)}</span>${hasPR ? `<a href="${e(link)}" target="_blank" rel="noopener noreferrer">${e(pr.title || (pr.number ? '#' + pr.number : 'Open PR'))} ↗</a><span class="pr-checks">Checks: ${e(pr.checks ?? 'unknown')} · Review: ${e((pr.review ?? 'unknown').replaceAll('_', ' '))}</span>${monitor?.status === 'running' ? '<small>Checking PR status…</small>' : pr.checkedAt ? `<small>Checked ${ago(pr.checkedAt).toLowerCase()}</small>` : ''}` : ''}</div><div class="pr-tracker-actions">${running ? `<button class="btn text small" data-action="delivery-run" data-id="${e(delivery?.id || '')}">View run</button><button class="btn text small" data-action="publication-pause" ${delivery?.stopRequested ? 'disabled' : ''}>${delivery?.stopRequested ? 'Stopping…' : 'Pause'}</button>` : !hasPR ? `<button class="btn ${blocked ? 'secondary' : 'primary'} small" data-action="confirm-submit" data-repository-id="${id}">${blocked ? 'Retry publishing' : 'Publish draft PR'}</button>` : `<button class="btn text small" data-action="publication-monitor" data-repository-id="${id}" data-enabled="true" ${monitor?.status === 'running' ? 'disabled' : ''}>${monitor?.status === 'running' ? 'Refreshing…' : 'Refresh status'}</button>`}<button class="btn text small" data-action="delivery-details" data-repository-id="${id}" aria-label="PR details for ${e(entry.repository.name)}">Details</button></div>${blocked ? `<p class="pr-tracker-blocker">${e(concise(delivery?.nextAction || delivery?.summary || 'Open details to inspect the publishing blocker.', 220))}</p>` : ''}</div>`;
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
  const observation = monitor?.summary || pr?.summary;
  const observationEvidence = monitor?.evidence || pr?.evidence || [];
  return `<div class="delivery-detail-content">${delivery?.summary ? `<p>${e(delivery.summary)}</p>` : ''}<div class="inline-actions"><button class="btn secondary small" data-action="publication-monitor" data-repository-id="${e(repositoryId)}" data-enabled="true">${pr?.url ? 'Refresh PR status' : 'Find existing PR'}</button>${monitor?.enabled ? `<button class="btn text small" data-action="publication-monitor" data-repository-id="${e(repositoryId)}" data-enabled="false">Pause monitoring</button>` : ''}<button class="btn text small" data-action="tab" data-tab="terminals">View live terminal</button></div>${pr?.checkedAt ? `<p class="muted">PR status last checked ${ago(pr.checkedAt).toLowerCase()}</p>` : ''}${observation ? `<section aria-label="Latest PR observation"><h3>Latest PR observation</h3><p>${e(observation)}</p>${monitor?.error && monitor.error !== observation ? `<p>${e(monitor.error)}</p>` : ''}<details><summary>Observation details &amp; evidence</summary>${monitor?.terminal ? `<button class="btn text small" data-action="monitor-terminal" data-terminal-id="${e(monitor.attemptId)}">View monitoring terminal</button>` : ''}<p>${e(monitor?.details || pr?.details || '')}</p>${observationEvidence.length ? `<ul>${observationEvidence.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : ''}</details></section>` : ''}<h3>Branch and commit</h3><dl><dt>Repository</dt><dd>${e(entry.repository.name)}</dd><dt>Branch</dt><dd><code>${e(entry.branch || 'Not assigned')}</code></dd><dt>Commit</dt><dd><code>${e(delivery?.commit || submission?.commit || 'Not committed yet')}</code></dd></dl>${delivery?.details ? `<h3>Publication agent findings</h3><p>${e(delivery.details)}</p>` : ''}${evidence.length ? `<h3>Evidence</h3><ul>${evidence.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : ''}${submission ? `<h3>Previous provider output</h3><pre class="delivery-provider-output">${e(submission.stdout || '')}${e(submission.stderr || submission.error || 'No output recorded.')}</pre>` : ''}</div>`;
}
