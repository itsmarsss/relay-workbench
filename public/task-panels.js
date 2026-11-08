import { taskRuns, currentTaskRun } from './task-runs.js';
import { runLabel } from './run-label.js';
import { verificationReport } from './verification-report.js';
import { e, stageNames, harnessBadge, prose, duration } from './ui.js';
import { concise } from './task-summary.js';
import { timer } from './live-progress.js';

export { runLabel } from './run-label.js';
export function handoffFiles(h) {
  if (!h) return '';
  return `${h.findings?.length ? `<section class="report-findings"><h4>Review findings</h4>${h.findings.map((f) => `<article><div class="finding-header"><span class="severity ${e(f.severity)}">${e(f.severity)}</span><strong>${e(f.file.split('/').at(-1))}</strong></div><code class="finding-path">${e(f.file)}</code><p>${e(f.description)}</p></article>`).join('')}</section>` : ''}${
    h.files?.length
      ? `<details class="report-section"><summary>Changed files <span>${h.files.length}</span></summary><ul class="report-files">${h.files
          .map((f) => {
            const parts = f.split('/');
            const name = parts.pop();
            return `<li><strong>${e(name)}</strong><code>${e(parts.join('/'))}</code></li>`;
          })
          .join('')}</ul></details>`
      : ''
  }`;
}
export function handoffBody(h) {
  if (!h) return '';
  return `<div class="handoff-report">${
    h.risks?.length
      ? `<section class="report-risks"><h4>Risks & limitations</h4><ul>${h.risks
          .slice(0, 2)
          .map((r) => `<li>${e(concise(r, 220))}</li>`)
          .join(
            '',
          )}</ul>${h.risks.length > 2 || h.risks.some((r) => r.length > 220) ? `<details class="report-section"><summary>Full risks &amp; limitations (${h.risks.length})</summary><ul>${h.risks.map((r) => `<li>${e(r)}</li>`).join('')}</ul></details>` : ''}</section>`
      : ''
  }${handoffFiles(h)}<div class="report-supporting">${verificationReport(h.verification)}${h.details ? `<details class="report-section"><summary>Explanation</summary><div class="prose report-prose">${prose(h.details)}</div></details>` : ''}${h.evidence?.length ? `<details class="report-section"><summary>Verification & evidence <span>${h.evidence.length}</span></summary><ul class="evidence-list">${h.evidence.map((v) => `<li>${e(v)}</li>`).join('')}</ul></details>` : ''}</div></div>`;
}
export function handoffList(task) {
  const attempts = taskRuns(task)
    .map((a, i) => ({ ...a, number: i + 1 }))
    .filter((a) => a.handoff || a.error)
    .reverse();
  return `<div class="panel-heading"><div><h2>Handoffs</h2><p>Latest outcome first. Open a run for the reasoning and evidence.</p></div><span class="panel-count">${attempts.length} runs</span></div>${attempts.length ? attempts.map((a, i) => `<details class="handoff-card report-card" data-event-key="handoff-${e(a.id)}" ${i === 0 ? 'open' : ''}><summary><div class="report-heading">${harnessBadge(a.harness)}<div><strong>${e(runLabel(a))}</strong><small>Run ${a.number} · ${e(a.harness)}${a.finishedAt ? ` · ${duration(new Date(a.finishedAt) - new Date(a.startedAt))}` : ''}</small></div><span class="verdict ${a.handoff?.verdict === 'complete' ? 'pass' : ['repair_requested', 'verification_requested'].includes(a.handoff?.verdict) ? 'pending' : 'fail'}">${e(a.handoff?.verdict === 'blocked' ? 'Blocked' : a.handoff?.verdict === 'complete' ? 'Complete' : a.handoff?.verdict === 'changes_requested' ? 'Changes requested' : a.handoff?.verdict === 'repair_requested' ? 'Repair delegated' : a.handoff?.verdict === 'verification_requested' ? 'Verification requested' : 'Failed')}</span></div><p class="report-takeaway">${e(concise(a.handoff?.summary || a.error, i === 0 ? 500 : 180))}</p></summary><div class="report-body">${(a.handoff?.summary || a.error || '').length > (i === 0 ? 500 : 180) ? `<p class="report-full-summary">${e(a.handoff?.summary || a.error)}</p>` : ''}${handoffBody(a.handoff)}</div></details>`).join('') : '<p class="panel-empty">Agent outcomes will appear here after the first run.</p>'}`;
}
export function workflowStages(task) {
  const live = ['running', 'queued'].includes(task.status);
  const subrun = task.attempts.findLast(
    (a) => ['debug', 'verifier'].includes(a.role) && a.status === 'running',
  );
  return Object.keys(stageNames)
    .map((stage, i) => {
      const a = task.attempts.findLast(
        (a) => a.stage === stage && !['debug', 'verifier'].includes(a.role),
      );
      const active = task.stage === stage && !['completed', 'cancelled'].includes(task.status);
      const done = a?.status === 'complete' && a.handoff?.verdict === 'complete';
      const h =
        stage === 'verify'
          ? 'Repository checks'
          : ({ codex: 'Codex', claude: 'Claude', pi: 'Pi' }[task.routing[stage]] ??
            task.routing[stage]);
      const suspended = active && live && subrun;
      return `<li class="${active ? 'current' : done ? 'done' : ''}"><span class="stage-number">${done && !active ? '✓' : i + 1}</span><div><strong>${e(stageNames[stage])}</strong><small>${suspended ? 'Waiting for ' + (subrun.role === 'verifier' ? 'checks' : 'diagnosis') : e(h)}${!suspended && a?.finishedAt ? ` · ${duration(new Date(a.finishedAt) - new Date(a.startedAt))}` : !suspended && active && live && a?.status === 'running' ? ` · ${timer(a.startedAt)}` : ''}</small>${suspended ? `<div class="workflow-subrun"><span class="pulse-dot"></span><span>${e(runLabel(subrun))}</span>${timer(subrun.startedAt)}</div>` : ''}</div>${active && live && !suspended ? '<span class="pulse-dot"></span>' : ''}</li>`;
    })
    .join('');
}
export function executionLogs(task, events, { run = 'latest', stream = 'all', query = '' } = {}) {
  const attempts = taskRuns(task);
  const selected = run === 'latest' ? currentTaskRun(task)?.id : run;
  const all = events.filter((ev) => ev.type === 'transcript');
  const visible = all.filter(
    (ev) =>
      (run === 'all' || ev.attemptId === selected) &&
      (stream === 'all' || ev.stream === stream) &&
      (!query || (ev.text ?? '').toLowerCase().includes(query.toLowerCase())),
  );
  return `<div class="panel-heading"><div><h2>Logs</h2><p>Command output by run.</p></div></div><div class="log-filters"><label>Run<select class="input" id="log-run"><option value="latest" ${run === 'latest' ? 'selected' : ''}>Current / latest run</option><option value="all" ${run === 'all' ? 'selected' : ''}>All runs</option>${attempts
    .map(
      (a, i) =>
        `<option value="${e(a.id)}" ${run === a.id ? 'selected' : ''}>${i + 1} · ${e(runLabel(a))} · ${e(a.harness)}</option>`,
    )
    .reverse()
    .join(
      '',
    )}</select></label><label>Output<select class="input" id="log-stream"><option value="all" ${stream === 'all' ? 'selected' : ''}>All output</option><option value="stderr" ${stream === 'stderr' ? 'selected' : ''}>stderr</option><option value="stdout" ${stream === 'stdout' ? 'selected' : ''}>stdout</option></select></label><label>Find<input class="input" id="log-search" placeholder="Search output…" value="${e(query)}"></label></div><div class="log-result-count">${visible.length} matching entries${visible.length > 400 ? ' · latest 400 shown' : ''}</div>${
    visible.length
      ? `<pre class="transcript" aria-label="Filtered execution output">${visible
          .slice(-400)
          .map(
            (ev) =>
              `<span class="log-line ${ev.stream === 'stderr' ? 'stderr' : ''}"><span class="log-stage">${e(ev.stage || '')}</span>${e(ev.text)}</span>`,
          )
          .join('\n')}</pre>`
      : '<p class="panel-empty">No output matches this selection.</p>'
  }`;
}
