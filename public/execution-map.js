import { e, stageNames } from './ui.js';
import { timer } from './live-progress.js';
export function executionNodes(task) {
  const attempts = task.attempts ?? [];
  return attempts.map((a, i) => {
    const parent = attempts.find((p) => p.id === a.parentAttemptId);
    const previous = attempts[i - 1];
    const relation =
      a.relation ??
      (a.role === 'debug'
        ? 'Diagnosis'
        : previous?.role === 'debug'
          ? 'Continue after diagnosis'
          : previous && (a.round ?? 0) > (previous.round ?? 0)
            ? 'Repair / backtrack'
            : previous?.stage === a.stage
              ? 'Retry / next repository'
              : 'Handoff');
    return {
      ...a,
      number: i + 1,
      parentNumber: parent ? attempts.indexOf(parent) + 1 : i || null,
      inferred: !a.parentAttemptId && i > 0,
      relation,
    };
  });
}
export function executionMap(task) {
  const nodes = executionNodes(task);
  const active = nodes.findLast((a) => a.status === 'running');
  return `<details class="execution-map context-card" data-event-key="execution-map"><summary>Execution map <span>${nodes.length} runs${active?.role === 'debug' ? ' · Debugger active' : ''}</span></summary><p class="form-help">Follow handoffs, diagnostic detours and repair loops. Expand a run for its result. Older links show recorded order when the cause was not saved.</p><ol class="execution-tree">${nodes.map((a) => `<li class="execution-node ${a.role === 'debug' ? 'debug-branch' : ''} ${a.status === 'running' ? 'is-running' : ''}"><details data-event-key="map-${e(a.id)}"><summary><span class="execution-node-number">${a.number}</span><span><strong>${a.role === 'debug' ? 'Debugger' : (stageNames[a.stage] ?? a.stage)}</strong><small>${e(a.harness)} · ${e(a.actualModel || a.model || (a.harness === 'checks' ? 'Configured commands' : 'CLI default · not reported'))}</small><small>${e(a.status)}${a.handoff?.verdict ? ` · ${e(a.handoff.verdict)}` : ''} · ${timer(a.startedAt, a.finishedAt)}</small></span></summary><p class="execution-edge">${a.parentNumber ? `${a.inferred ? 'After' : 'From'} run ${a.parentNumber} → ` : ''}${e(a.relation)}${a.repositoryId ? ` · ${e(a.repositoryId)}` : ''}</p>${a.handoff ? `<p>${e(a.handoff.summary)}</p><p>${e(a.handoff.details)}</p>` : a.error ? `<p>${e(a.error)}</p>` : '<p>Waiting for a structured result.</p>'}</details></li>`).join('') || '<li>No runs yet.</li>'}</ol>${task.approvals?.length ? `<details data-event-key="map-approvals"><summary>Human approvals (${task.approvals.length})</summary><ul>${task.approvals.map((a) => `<li>${e(a.type)} · ${e(a.option?.title ?? 'Accepted')} · ${e(a.at ?? '')}</li>`).join('')}</ul></details>` : ''}</details>`;
}
export function debuggerStep(task) {
  const a = task.attempts?.findLast((a) => a.role === 'debug' && a.status === 'running');
  if (!a || task.status !== 'running') return '';
  return `<li class="current debugger-step"><span class="stage-number">↳</span><div><strong>Debugger</strong><small>${e(a.harness)} · ${e(a.actualModel || a.model || 'CLI default')} · ${timer(a.startedAt)}</small><small>Diagnosing ${e(stageNames[a.stage] ?? a.stage)}</small></div><span class="pulse-dot"></span></li>`;
}
