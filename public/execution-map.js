import { runLabel } from './run-label.js';
import { e, stageNames, harnessBadge } from './ui.js';
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
export function graphLayout(task) {
  const nodes = executionNodes(task).map((node, i) => ({
    ...node,
    x: 40 + i * 280,
    y:
      node.role === 'debug'
        ? 236
        : node.role === 'verifier' || node.harness === 'checks'
          ? 416
          : 56,
  }));
  const edges = nodes
    .filter((n) => n.parentNumber)
    .map((n) => {
      const parent = nodes[n.parentNumber - 1];
      const startX = parent.x + 224;
      const endX = n.x;
      const midX = (startX + endX) / 2;
      return {
        from: parent.number,
        to: n.number,
        inferred: n.inferred,
        relation: n.relation,
        path: `M ${startX} ${parent.y + 48} C ${midX} ${parent.y + 48}, ${midX} ${n.y + 48}, ${endX} ${n.y + 48}`,
      };
    });
  return { nodes, edges, width: Math.max(800, nodes.length * 280 + 40), height: 560 };
}
export function executionMap(task, { selectedId, zoom = 1 } = {}) {
  const { nodes, edges, width, height } = graphLayout(task);
  const selected = nodes.find((n) => n.id === selectedId) ?? nodes.at(-1);
  const short = (value, max = 31) =>
    String(value ?? '').length > max ? String(value).slice(0, max - 1) + '…' : String(value ?? '');
  const status = (a) =>
    a.handoff?.verdict === 'repair_requested'
      ? 'Repair delegated'
      : a.handoff?.verdict === 'verification_requested'
        ? 'Verification requested'
        : a.handoff?.verdict === 'blocked'
          ? 'Blocked'
          : a.handoff?.verdict === 'changes_requested'
            ? 'Changes requested'
            : a.status === 'complete'
              ? 'Completed'
              : a.status;
  return `<section class="execution-map graph-dialog" role="region" aria-label="Execution graph"><header class="graph-header"><div><h2>Execution graph</h2><p>${nodes.length} runs · left to right · select a run to inspect</p></div><div class="inline-actions"><button class="btn secondary small" data-action="graph-current">Current run</button><button class="btn secondary small" data-action="graph-zoom-out" aria-label="Zoom out">−</button><button class="btn text small" data-action="graph-reset">${Math.round(zoom * 100)}%</button><button class="btn secondary small" data-action="graph-zoom-in" aria-label="Zoom in">+</button><button class="btn text small" data-action="close-execution-map" aria-label="Close execution graph">✕</button></div></header><div class="graph-legend"><span><i></i>Workflow</span><span><i class="debug"></i>Debugger</span><span><i class="checks"></i>Verification</span><small>Solid: recorded handoff · Dashed: historical order</small></div><div class="graph-body"><div class="node-graph-scroll" tabindex="0" aria-label="Scrollable execution graph"><svg class="node-graph" width="${width * zoom}" height="${height * zoom}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task runs and their connected execution paths"><defs><marker id="execution-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#7c8d70"/></marker></defs>${[
    ['WORKFLOW', 24],
    ['DEBUGGER', 204],
    ['HOST CHECKS', 384],
  ]
    .map(
      ([name, y]) =>
        `<rect class="graph-lane" x="16" y="${y + 14}" width="${width - 32}" height="132" rx="12"/><text x="40" y="${y}" class="graph-lane-title">${name}</text>`,
    )
    .join(
      '',
    )}${edges.map((edge) => `<path class="graph-edge ${edge.inferred ? 'inferred' : ''}" d="${edge.path}" marker-end="url(#execution-arrow)"><title>${edge.inferred ? 'Recorded order: ' : ''}${e(edge.relation)} · ${edge.from} → ${edge.to}</title></path>`).join('')}${nodes.map((a) => `<g class="graph-node ${a.role === 'debug' ? 'debug-branch' : a.role === 'verifier' || a.harness === 'checks' ? 'checks-branch' : ''} ${a.status === 'running' ? 'is-running' : ''} ${a.handoff?.verdict === 'blocked' || a.status === 'failed' ? 'is-blocked' : ''} ${selected?.id === a.id ? 'selected' : ''}" transform="translate(${a.x} ${a.y})" role="button" tabindex="0" aria-label="Run ${a.number}: ${e(runLabel(a))}, ${e(status(a))}" data-action="graph-select" data-id="${e(a.id)}"><rect width="224" height="96" rx="10"/><text x="16" y="25" class="graph-node-title">${a.number}. ${e(runLabel(a))}</text><text x="16" y="47">${e(short(`${a.harness} · ${a.actualModel || a.model || (a.harness === 'checks' ? 'configured commands' : 'CLI default')}`))}</text><text x="16" y="72" class="graph-node-status">${e(short(status(a)))}</text><title>${e(a.relation)}${a.handoff ? `: ${e(a.handoff.summary)}` : ''}</title></g>`).join('')}</svg>${!nodes.length ? '<p class="graph-empty">Start the workflow to see its execution path.</p>' : ''}</div><aside class="graph-inspector">${
    selected
      ? `<span class="eyebrow">SELECTED RUN · ${selected.number}</span><div class="graph-inspector-title">${harnessBadge(selected.harness)}<h3>${e(runLabel(selected))}</h3></div><span class="graph-status">${e(status(selected))}</span><dl class="graph-metadata"><dt>Model</dt><dd>${e(selected.actualModel || selected.model || (selected.harness === 'checks' ? 'Configured commands' : 'CLI default · not reported'))}</dd><dt>Path</dt><dd>${e(selected.relation)}${selected.parentNumber ? ` · From run ${selected.parentNumber}` : ''}</dd><dt>Duration</dt><dd>${timer(selected.startedAt, selected.finishedAt)}</dd></dl><p class="graph-run-summary">${e(selected.handoff?.summary || selected.error || 'Output and evidence appear as this run progresses.')}</p><button class="btn secondary" data-action="graph-open-activity" data-id="${e(selected.id)}">Open run activity ↗</button>${
          selected.handoff?.evidence?.length
            ? `<h4>Evidence</h4><ul class="graph-evidence">${selected.handoff.evidence
                .slice(0, 8)
                .map((v) => `<li>${e(v)}</li>`)
                .join('')}</ul>`
            : ''
        }${selected.handoff?.details ? `<details class="event-details"><summary>Full handoff</summary><p class="graph-handoff">${e(selected.handoff.details)}</p></details>` : ''}`
      : '<p>No runs yet.</p>'
  }</aside></div></section>`;
}
export function debuggerStep(task) {
  const a = task.attempts?.findLast(
    (a) => ['debug', 'verifier'].includes(a.role) && a.status === 'running',
  );
  if (!a || task.status !== 'running') return '';
  if (a.role === 'verifier')
    return `<li class="current debugger-step"><span class="stage-number">↳</span><div><strong>${e(runLabel(a))}</strong><small>${a.harness !== 'checks' ? e(a.harness) : 'Configured checks'} · ${timer(a.startedAt)}</small><small>Results return to the interrupted agent</small></div><span class="pulse-dot"></span></li>`;
  return `<li class="current debugger-step"><span class="stage-number">↳</span><div><strong>${a.executionAccess === 'host' ? 'Elevated debugger' : 'Debugger'}</strong><small>${e(a.harness)} · ${e(a.actualModel || a.model || 'CLI default')} · ${timer(a.startedAt)}</small><small>Diagnosing ${e(stageNames[a.stage] ?? a.stage)}</small></div><span class="pulse-dot"></span></li>`;
}
