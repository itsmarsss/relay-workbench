import { workflowRow } from './run-presentation.js';
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
  if (task.demo || task.preset === 'investigate') return '';
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  const publishing = entries.some(
    (r) => r.delivery?.status === 'running' || r.submission?.status === 'running',
  );
  const published = entries.every(
    (r) =>
      (r.delivery?.status === 'complete' && r.delivery?.phase === 'monitoring') ||
      ['open', 'closed', 'merged'].includes(r.publication?.state),
  );
  const records = entries
    .map((entry) => entry.delivery)
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0));
  const run = records.findLast((record) => record.status === 'running') || records.at(-1);
  const currentCycle =
    !task.followUpContext ||
    (records.length === entries.length &&
      records.every((record) => record.startedAt >= task.followUpContext.startedAt));
  const done = published && currentCycle;
  return workflowRow({
    title: 'Publish',
    index: 7,
    run: currentCycle ? run : null,
    state: {
      key: publishing
        ? 'running'
        : done
          ? 'complete'
          : ['blocked', 'interrupted'].includes(run?.status) && currentCycle
            ? 'blocked'
            : 'pending',
      label: publishing
        ? 'Running'
        : done
          ? 'Published'
          : ['blocked', 'interrupted'].includes(run?.status) && currentCycle
            ? 'Blocked'
            : 'Pending',
      mark: publishing ? '●' : done ? '✓' : '!',
    },
    fallback: task.status === 'completed' ? 'Ready to publish' : 'After acceptance',
  });
}
export function publicationPanel(task) {
  if (task.status !== 'completed' || task.demo || task.preset === 'investigate') return '';
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
      const needsUpdate =
        !!task.followUpContext &&
        (!delivery?.startedAt || delivery.startedAt < task.followUpContext.startedAt);
      const label = running
        ? 'Publishing…'
        : blocked
          ? 'Publishing needs attention'
          : hasPR
            ? { open: pr.draft ? 'Draft PR' : 'Open PR', merged: 'Merged', closed: 'Closed' }[
                pr.state
              ]
            : 'Not published';
      return `<div class="pr-tracker-row"><div class="pr-tracker-state"><strong>${entries.length > 1 ? e(entry.repository.name) : 'Pull request'}</strong><span class="badge ${blocked ? 'blocked' : running ? 'running' : ''}">${e(label)}</span>${hasPR ? `<a href="${e(link)}" target="_blank" rel="noopener noreferrer">${e(pr.title || (pr.number ? '#' + pr.number : 'Open PR'))} ↗</a><span class="pr-checks">Checks: ${e(pr.checks ?? 'unknown')} · Review: ${e((pr.review ?? 'unknown').replaceAll('_', ' '))}</span>${monitor?.status === 'running' ? '<small>Checking PR status…</small>' : pr.checkedAt ? `<small>Checked ${ago(pr.checkedAt).toLowerCase()}</small>` : ''}` : ''}</div><div class="pr-tracker-actions">${running ? `<button class="btn text small" data-action="delivery-run" data-id="${e(delivery?.id || '')}">View run</button><button class="btn text small" data-action="publication-pause" ${delivery?.stopRequested ? 'disabled' : ''}>${delivery?.stopRequested ? 'Stopping…' : 'Pause'}</button>` : !hasPR || needsUpdate ? `<button class="btn ${blocked ? 'secondary' : 'primary'} small" data-action="confirm-submit" data-repository-id="${id}">${blocked ? 'Retry publishing' : needsUpdate && hasPR ? 'Update PR' : 'Publish draft PR'}</button>` : `<button class="btn text small" data-action="publication-monitor" data-repository-id="${id}" data-enabled="true" ${monitor?.status === 'running' ? 'disabled' : ''}>${monitor?.status === 'running' ? 'Refreshing…' : 'Refresh status'}</button>`}<button class="btn text small" data-action="delivery-details" data-repository-id="${id}" aria-label="PR details for ${e(entry.repository.name)}">Details</button></div>${hasPR && pr.state === 'open' && !entry.feedbackAutopilot?.enabled ? `<button class="btn secondary small" data-action="feedback-toggle" data-repository-id="${id}" data-enabled="true">Fix PR feedback</button>` : ''}${blocked ? `<p class="pr-tracker-blocker">${e(concise(delivery?.nextAction || delivery?.summary || 'Open details to inspect the publishing blocker.', 220))}</p>` : ''}</div>`;
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
  const link = safeURL(pr?.url);
  const state = pr
    ? ({ open: pr.draft ? 'Draft' : 'Open', merged: 'Merged', closed: 'Closed' }[pr.state] ??
      'Unknown')
    : 'Not published';
  return `<div class="delivery-detail-content">${feedbackSummary(entry)}<section class="pr-detail-overview"><div class="pr-detail-heading"><span class="detail-kicker">${e(entry.repository.name)}</span><span class="badge">${e(state)}</span></div>${link ? `<a class="pr-detail-link" href="${e(link)}" target="_blank" rel="noopener noreferrer">${e(pr.title || 'Open pull request')} ↗</a>` : '<h3>Pull request not created yet</h3>'}<div class="pr-detail-signals"><span>Checks <strong>${e(pr?.checks ?? 'Unknown')}</strong></span><span>Review <strong>${e((pr?.review ?? 'Unknown').replaceAll('_', ' '))}</strong></span></div>${pr?.checkedAt ? `<small class="detail-muted">Updated ${ago(pr.checkedAt).toLowerCase()}</small>` : ''}</section>${delivery?.status === 'blocked' || delivery?.status === 'interrupted' ? `<section class="detail-attention"><h3>Needs attention</h3><p>${e(delivery.nextAction || delivery.summary)}</p></section>` : ''}<div class="detail-actions"><button class="btn secondary small" data-action="publication-monitor" data-repository-id="${e(repositoryId)}" data-enabled="true" ${monitor?.status === 'running' ? 'disabled' : ''}>${monitor?.status === 'running' ? 'Refreshing…' : pr?.url ? 'Refresh PR status' : 'Find existing PR'}</button><button class="btn text small" data-action="tab" data-tab="terminals">View live terminal</button>${monitor?.enabled ? `<button class="btn text small" data-action="publication-monitor" data-repository-id="${e(repositoryId)}" data-enabled="false">Pause monitoring</button>` : ''}</div><section class="detail-section"><h3>Latest update</h3><p>${e(delivery?.summary || observation || 'No publication updates yet.')}</p>${observation && observation !== delivery?.summary ? `<p class="detail-muted">${e(observation)}</p>` : ''}</section><details class="detail-disclosure" data-event-key="pr-branch-${e(repositoryId)}"><summary>Branch &amp; commit</summary><dl class="detail-facts"><div><dt>Branch</dt><dd><code class="detail-path">${e(entry.branch || 'Not assigned')}</code></dd></div><div><dt>Commit</dt><dd><code class="detail-path">${e(delivery?.commit || submission?.commit || 'Not committed yet')}</code></dd></div></dl></details>${delivery?.details || evidence.length ? `<details class="detail-disclosure"><summary>Publication evidence</summary>${delivery?.details ? `<p>${e(delivery.details)}</p>` : ''}${evidence.length ? `<ul>${evidence.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : ''}</details>` : ''}${observation ? `<details class="detail-disclosure" aria-label="Latest PR observation"><summary>Observation details &amp; evidence</summary>${monitor?.error ? `<p class="error-text">${e(monitor.error)}</p>` : ''}<p>${e(monitor?.details || pr?.details || '')}</p>${observationEvidence.length ? `<ul>${observationEvidence.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : ''}${monitor?.terminal ? `<button class="btn text small" data-action="monitor-terminal" data-terminal-id="${e(monitor.attemptId)}">View monitoring terminal</button>` : ''}</details>` : ''}${submission ? `<details class="detail-disclosure"><summary>Provider output</summary><pre class="delivery-provider-output">${e(submission.stdout || '')}${e(submission.stderr || submission.error || 'No output recorded.')}</pre></details>` : ''}</div>`;
}

export function feedbackSummary(entry) {
  const current = entry.feedbackAutopilot?.current;
  if (!current || ['complete', 'dismissed'].includes(current.state)) return '';
  return `<details class="feedback-summary" data-event-key="feedback-${e(current.id)}"><summary>${current.state === 'needs_decision' ? 'Feedback needs your direction' : current.state === 'publishing' ? 'Publishing accepted feedback repairs' : 'Feedback repair workflow'} · ${current.items.length} items</summary><p>${e(current.reason)}</p><ul>${current.items.map((item) => `<li><strong>${e(item.summary)}</strong><p>${e(item.details)}</p>${safeURL(item.url) ? `<a href="${e(safeURL(item.url))}" target="_blank" rel="noopener noreferrer">Source feedback ↗</a>` : ''}</li>`).join('')}</ul>${current.state === 'needs_decision' ? `<p class="detail-muted">Use Continue work below to give direction, or mark this feedback reviewed.</p><button class="btn secondary small" data-action="feedback-dismiss" data-repository-id="${e(entry.repository.id)}" data-feedback-id="${e(current.id)}">Mark reviewed</button>` : ''}</details>`;
}

export function feedbackWorkflowStage(task) {
  const entries = (task.repositories?.length > 1 ? task.repositories : [task]).filter(
    (e) => e.feedbackAutopilot?.enabled || e.feedbackAutopilot?.current,
  );
  if (!entries.length) return '';
  const entry =
      entries.find(
        (e) =>
          e.feedbackAutopilot.enabled &&
          ['needs_decision', 'proposed', 'publishing'].includes(e.feedbackAutopilot.current?.state),
      ) ??
      entries.find((e) => e.feedbackAutopilot.enabled) ??
      entries[0],
    policy = entry.feedbackAutopilot,
    current = policy.current;
  const run = (task.deliveryRuns ?? []).findLast(
    (r) => r.stage === 'feedback' && r.repositoryId === entry.repository.id,
  );
  const phase = !policy.enabled
    ? 'Paused'
    : current?.state === 'needs_decision'
      ? 'Needs you'
      : current?.state === 'publishing'
        ? 'Updating PR'
        : current?.state === 'proposed'
          ? task.status === 'awaiting_plan'
            ? 'Approve repair'
            : task.status === 'awaiting_final'
              ? 'Review repair'
              : 'Repairing'
          : current?.state === 'complete'
            ? 'Repairs published'
            : 'Watching PR';
  const state = {
    key: !policy.enabled
      ? 'paused'
      : current?.state === 'needs_decision'
        ? 'blocked'
        : current?.state === 'complete'
          ? 'complete'
          : ['publishing', 'proposed'].includes(current?.state)
            ? 'running'
            : 'pending',
    label: phase,
    mark: current?.state === 'complete' ? '✓' : '○',
  };
  return workflowRow({
    title: 'PR feedback',
    index: 8,
    run: run ?? null,
    state,
    fallback: 'Added to workflow',
    extra: `<span class="feedback-step-actions"><button class="btn text small" data-action="open-feedback-activity" data-run="${e(run?.id ?? 'all')}">Activity</button>${policy.enabled ? `<button class="btn text small" data-action="feedback-toggle" data-enabled="false" data-repository-id="${e(entry.repository.id)}">Pause</button>` : ''}</span>`,
  });
}
