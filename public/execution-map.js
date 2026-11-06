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
    x: node.role === 'debug' ? 430 : 40,
    y: 70 + i * 132,
  }));
  const edges = nodes
    .filter((n) => n.parentNumber)
    .map((n) => {
      const parent = nodes[n.parentNumber - 1];
      return {
        from: parent.number,
        to: n.number,
        inferred: n.inferred,
        relation: n.relation,
        path: `M ${parent.x + 150} ${parent.y + 88} C ${parent.x + 150} ${parent.y + 116}, ${n.x + 150} ${n.y - 28}, ${n.x + 150} ${n.y}`,
      };
    });
  return { nodes, edges, width: 790, height: Math.max(250, nodes.length * 132 + 100) };
}
export function executionMap(task, { selectedId, zoom = 1 } = {}) {
  const { nodes, edges, width, height } = graphLayout(task);
  const selected = nodes.find((n) => n.id === selectedId) ?? nodes.at(-1);
  const short = (value, max = 38) =>
    String(value ?? '').length > max ? String(value).slice(0, max - 1) + '…' : String(value ?? '');
  return `<section class="execution-map graph-dialog" role="region" aria-label="Execution graph"><header class="graph-header"><div><h2>Execution graph</h2><p>${nodes.length} runs · click a node for its evidence</p></div><div class="inline-actions"><button class="btn secondary small" data-action="graph-zoom-out" aria-label="Zoom out">−</button><button class="btn text small" data-action="graph-reset">${Math.round(zoom * 100)}%</button><button class="btn secondary small" data-action="graph-zoom-in" aria-label="Zoom in">+</button><button class="btn text small" data-action="close-execution-map" aria-label="Close execution graph">✕</button></div></header><div class="graph-body"><div class="node-graph-scroll" tabindex="0" aria-label="Scrollable execution graph"><svg class="node-graph" width="${width * zoom}" height="${height * zoom}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task runs and their connected execution paths"><defs><marker id="execution-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#7c8d70"/></marker></defs><text x="40" y="32" class="graph-lane-title">WORKFLOW</text><text x="430" y="32" class="graph-lane-title">DEBUGGER DETOURS</text>${edges.map((edge) => `<path class="graph-edge ${edge.inferred ? 'inferred' : ''}" d="${edge.path}" marker-end="url(#execution-arrow)"><title>${edge.inferred ? 'Recorded order: ' : ''}${e(edge.relation)} · ${edge.from} → ${edge.to}</title></path>`).join('')}${nodes.map((a) => `<g class="graph-node ${a.role === 'debug' ? 'debug-branch' : ''} ${a.status === 'running' ? 'is-running' : ''} ${selected?.id === a.id ? 'selected' : ''}" transform="translate(${a.x} ${a.y})" role="button" tabindex="0" aria-label="Run ${a.number}: ${e(a.role === 'debug' ? 'Debugger' : (stageNames[a.stage] ?? a.stage))}, ${e(a.status)}" data-action="graph-select" data-id="${e(a.id)}"><rect width="300" height="88" rx="12"/><text x="16" y="24" class="graph-node-title">${a.number}. ${e(a.role === 'debug' ? 'Debugger' : (stageNames[a.stage] ?? a.stage))}</text><text x="16" y="46">${e(short(`${a.harness} · ${a.actualModel || a.model || 'CLI default'}`))}</text><text x="16" y="68">${e(a.status)}${a.handoff?.verdict ? ` · ${e(a.handoff.verdict)}` : ''}</text><title>${e(a.relation)}${a.handoff ? `: ${e(a.handoff.summary)}` : ''}</title></g>`).join('')}</svg></div><aside class="graph-inspector">${selected ? `${harnessBadge(selected.harness)}<h3>Run ${selected.number} · ${selected.role === 'debug' ? 'Debugger' : (stageNames[selected.stage] ?? selected.stage)}</h3><p>${e(selected.actualModel || selected.model || 'CLI default · not reported')}</p><p>${e(selected.relation)}${selected.parentNumber ? ` · From run ${selected.parentNumber}` : ''}</p><p>${timer(selected.startedAt, selected.finishedAt)}</p><strong>${e(selected.handoff?.summary || selected.error || 'Run in progress')}</strong><p>${e(selected.handoff?.details || '')}</p>${selected.handoff?.evidence?.length ? `<details><summary>Evidence</summary><ul>${selected.handoff.evidence.map((v) => `<li>${e(v)}</li>`).join('')}</ul></details>` : ''}` : '<p>No runs yet.</p>'}<p class="form-help">Dashed edges show historical run order where a causal link was not recorded.</p></aside></div></section>`;
}
export function debuggerStep(task) {
  const a = task.attempts?.findLast((a) => a.role === 'debug' && a.status === 'running');
  if (!a || task.status !== 'running') return '';
  return `<li class="current debugger-step"><span class="stage-number">↳</span><div><strong>Debugger</strong><small>${e(a.harness)} · ${e(a.actualModel || a.model || 'CLI default')} · ${timer(a.startedAt)}</small><small>Diagnosing ${e(stageNames[a.stage] ?? a.stage)}</small></div><span class="pulse-dot"></span></li>`;
}
