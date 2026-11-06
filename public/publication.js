import { e, ago } from './ui.js';
function safeURL(value) {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}
export function publicationPanel(task) {
  if (!['awaiting_final', 'completed'].includes(task.status) || task.demo) return '';
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  return `<section class="publication-panel" aria-label="Commit and pull requests"><div class="publication-heading"><div><span class="eyebrow">DELIVERY</span><h2>${task.status === 'awaiting_final' ? 'After you accept' : 'Your changes are accepted'}</h2><p>${task.status === 'awaiting_final' ? 'Accepting saves your approval. Then commit and submit each repository separately.' : 'Commit and submit when ready. PR monitoring observes remote status without changing code or publishing anything.'}</p></div></div>${entries
    .map((entry) => {
      const id = e(entry.repository.id),
        submission = entry.submission,
        pr = entry.publication,
        monitor = entry.publicationMonitor;
      const link = safeURL(pr?.url);
      const hasPR = !!link && ['open', 'closed', 'merged'].includes(pr?.state);
      const state =
        pr?.state === 'open'
          ? pr.draft
            ? 'Draft'
            : 'Open'
          : ({
              merged: 'Merged',
              closed: 'Closed',
              not_created: 'No PR found',
              unknown: 'Status unknown',
            }[pr?.state] ??
            (submission?.status === 'running'
              ? 'Submitting'
              : monitor?.status === 'running'
                ? 'Checking status'
                : submission?.status === 'complete'
                  ? 'Submitted'
                  : submission?.status === 'failed'
                    ? 'Submission failed'
                    : submission?.status === 'interrupted'
                      ? 'Submission interrupted'
                      : 'Not submitted'));
      return `<article class="publication-repository"><div class="publication-repo-heading"><strong>${e(entry.repository.name)}</strong><span class="badge">${e(state)}</span></div>${link ? `<a class="publication-link" href="${e(link)}" target="_blank" rel="noopener noreferrer">${e(pr.title || `Pull request ${pr.number || ''}`)} ↗</a>` : ''}<div class="publication-facts"><span>Branch <code>${e(entry.branch || 'Not assigned')}</code></span>${submission?.commit ? `<span>Commit <code title="${e(submission.commit)}">${e(submission.commit.slice(0, 10))}</code></span>` : ''}${pr && ['open', 'merged', 'closed'].includes(pr.state) ? `<span>Checks <strong>${e(pr.checks)}</strong></span><span>Review <strong>${e(pr.review.replaceAll('_', ' '))}</strong></span>` : ''}</div>${pr?.summary ? `<p>${e(pr.summary)}</p>` : ''}${monitor?.error ? `<p role="status">Status unavailable: ${e(monitor.error)}</p>` : ''}${submission?.status === 'failed' || submission?.status === 'interrupted' ? `<p role="status">Submission ${e(submission.status)}. ${e(submission.error || 'Inspect provider output before attempting publication again.')}</p>` : ''}${task.status === 'completed' ? `<div class="inline-actions">${!submission && !hasPR && entry.repository.prCommand ? `<button class="btn primary small" data-action="confirm-submit" data-repository-id="${id}">Commit &amp; submit draft PR</button>` : ''}${!submission && !hasPR && !entry.repository.prCommand ? '<span>No publication command configured. You can publish manually, then ask the monitor to locate the PR.</span>' : ''}${submission?.status !== 'running' ? `<button class="btn secondary small" data-action="publication-monitor" data-repository-id="${id}" data-enabled="true" ${monitor?.status === 'running' ? 'disabled' : ''}>${monitor?.status === 'running' ? 'Checking PR status…' : 'Check PR status'}</button>${monitor?.enabled ? `<button class="btn text small" data-action="publication-monitor" data-repository-id="${id}" data-enabled="false">Pause monitoring</button>` : ''}` : ''}</div>` : ''}<small>${pr?.checkedAt ? `Checked ${ago(pr.checkedAt).toLowerCase()}. ` : ''}${monitor?.enabled ? 'An agent checks periodically; no automatic repairs or merge.' : monitor ? 'Monitoring paused.' : ''}</small>${submission || pr?.evidence?.length ? `<details class="event-details" data-event-key="publication-${id}"><summary>Commit, provider output &amp; evidence</summary>${pr?.evidence?.length ? `<ul>${pr.evidence.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : ''}${submission ? `<pre class="code-block">${e(submission.stdout || submission.error || 'No provider output yet.')}${e(submission.stderr || '')}</pre>` : ''}</details>` : ''}</article>`;
    })
    .join('')}</section>`;
}
