import { taskRuns } from './task-runs.js';
import { runLabel } from './run-label.js';
import { e, stageNames, harnessBadge } from './ui.js';
import { runState, harnessName, runTiming } from './run-presentation.js';
import { timer } from './live-progress.js';
export function executionNodes(task) {
  const attempts = taskRuns(task);
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
const laneFor = (node) =>
  node.role === 'debug'
    ? 'debug'
    : node.role === 'verifier' || node.harness === 'checks'
      ? 'verify'
      : 'workflow';
const laneNames = { workflow: 'Workflow', debug: 'Debugging', verify: 'Verification' };
export function graphLayout(task) {
  const runs = executionNodes(task);
  const lanes = ['workflow', 'debug', 'verify']
    .filter((key) => runs.some((n) => laneFor(n) === key))
    .map((key, index) => ({ key, label: laneNames[key], y: 24 + index * 164 }));
  const nodes = runs.map((node, index) => ({
    ...node,
    lane: laneFor(node),
    x: 32 + index * 268,
    y: 58 + lanes.findIndex((l) => l.key === laneFor(node)) * 164,
  }));
  const edges = nodes
    .filter((n) => n.parentNumber)
    .map((n) => {
      const parent = nodes[n.parentNumber - 1];
      const startX = parent.x + 216,
        endX = n.x,
        midX = (startX + endX) / 2;
      return {
        from: parent.number,
        to: n.number,
        inferred: n.inferred,
        relation: n.relation,
        path: `M ${startX} ${parent.y + 52} C ${midX} ${parent.y + 52}, ${midX} ${n.y + 52}, ${endX} ${n.y + 52}`,
      };
    });
  return {
    nodes,
    edges,
    lanes,
    width: Math.max(640, nodes.length * 268 + 12),
    height: Math.max(240, lanes.length * 164 + 24),
  };
}
export function executionMap(task, { selectedId, zoom = 1 } = {}) {
  const { nodes, edges, lanes, width, height } = graphLayout(task);
  const selected =
    nodes.find((n) => n.id === selectedId) ??
    nodes.findLast((n) => n.status === 'running') ??
    nodes.at(-1);
  const short = (value, max = 24) =>
    String(value ?? '').length > max ? String(value).slice(0, max - 1) + '…' : String(value ?? '');
  const status = (a) =>
    a.handoff?.verdict === 'repair_requested'
      ? 'Repair delegated'
      : a.handoff?.verdict === 'verification_requested'
        ? 'Verification requested'
        : runState(a).label;
  return `<section class="execution-map graph-dialog" role="region" aria-label="Execution graph"><header class="graph-header"><div><span class="detail-kicker">WORKFLOW HISTORY</span><h2>Execution graph <span class="graph-run-count">${nodes.length} runs</span></h2></div><div class="graph-toolbar"><button class="btn secondary small" data-action="graph-current">Latest run</button><div class="graph-zoom-controls"><button class="btn text small" data-action="graph-zoom-out" aria-label="Zoom out">−</button><button class="btn text small" data-action="graph-reset" aria-label="Reset zoom">${Math.round(zoom * 100)}%</button><button class="btn text small" data-action="graph-zoom-in" aria-label="Zoom in">+</button></div><button class="btn text small" data-action="graph-fit">Fit view</button><button class="btn text small graph-close" data-action="close-execution-map" aria-label="Close execution graph">✕</button></div></header><div class="graph-body"><div class="graph-canvas"><div class="graph-canvas-caption"><span>Select a run to inspect its outcome</span><small>Dashed links show recorded order</small></div><div class="node-graph-scroll" tabindex="0" aria-label="Scrollable execution graph"><svg class="node-graph" width="${width * zoom}" height="${height * zoom}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task runs and their connected execution paths"><defs><marker id="execution-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#84918b"/></marker></defs>${lanes.map((lane) => `<rect class="graph-lane" x="16" y="${lane.y + 18}" width="${width - 32}" height="126" rx="8"/><text x="32" y="${lane.y}" class="graph-lane-title">${e(lane.label)}</text>`).join('')}${edges.map((edge) => `<path class="graph-edge ${edge.inferred ? 'inferred' : ''}" d="${edge.path}" marker-end="url(#execution-arrow)"><title>${edge.inferred ? 'Recorded order: ' : ''}${e(edge.relation)} · ${edge.from} → ${edge.to}</title></path>`).join('')}${nodes.map((node) => `<g class="graph-node ${node.lane === 'debug' ? 'debug-branch' : node.lane === 'verify' ? 'checks-branch' : ''} ${node.status === 'running' ? 'is-running' : ''} ${['blocked', 'failed'].includes(runState(node).key) ? 'is-blocked' : ''} ${selected?.id === node.id ? 'selected' : ''}" transform="translate(${node.x} ${node.y})" role="button" tabindex="0" aria-label="Run ${node.number}: ${e(runLabel(node))}, ${e(status(node))}" data-action="graph-select" data-id="${e(node.id)}"><rect width="216" height="104" rx="8"/><text x="14" y="23" class="graph-node-meta">${e(harnessName(node.harness))} · RUN ${node.number}</text><text x="14" y="47" class="graph-node-title">${e(short(runLabel(node)))}</text><circle cx="18" cy="76" r="3" class="graph-status-dot ${e(runState(node).key)}"/><text x="29" y="80" class="graph-node-status">${e(short(status(node)))}</text><title>${e(node.relation)}${node.handoff ? `: ${e(node.handoff.summary)}` : ''}</title></g>`).join('')}</svg>${!nodes.length ? '<p class="graph-empty">Start the workflow to see its execution path.</p>' : ''}</div></div><aside class="graph-inspector">${selected ? `<div class="graph-inspector-heading"><span class="detail-kicker">RUN ${selected.number}</span><span class="run-status ${e(runState(selected).key)}">${e(status(selected))}</span></div><div class="graph-inspector-title">${harnessBadge(selected.harness)}<h3>${e(runLabel(selected))}</h3></div><p class="graph-run-summary">${e(selected.handoff?.summary || selected.error || 'Output and evidence appear as this run progresses.')}</p><button class="btn secondary small graph-open-run" data-action="graph-open-activity" data-id="${e(selected.id)}">Open run activity ↗</button><dl class="detail-facts graph-facts"><div><dt>Agent</dt><dd>${e(harnessName(selected.harness))}</dd></div><div><dt>Model</dt><dd>${e(selected.actualModel || selected.model || (selected.harness === 'checks' ? 'Configured commands' : 'CLI default · not reported'))}</dd></div><div><dt>Duration</dt><dd>${runTiming(selected) || 'Not started'}</dd></div><div><dt>Handoff</dt><dd>${e(selected.relation)}${selected.parentNumber ? `<small>From run ${selected.parentNumber}</small>` : ''}</dd></div></dl>${selected.handoff?.evidence?.length ? `<details class="detail-disclosure"><summary>Evidence <span>${selected.handoff.evidence.length}</span></summary><ul class="graph-evidence">${selected.handoff.evidence.map((v) => `<li>${e(v)}</li>`).join('')}</ul></details>` : ''}${selected.handoff?.details ? `<details class="detail-disclosure"><summary>Full handoff</summary><p class="graph-handoff">${e(selected.handoff.details)}</p></details>` : ''}` : '<p class="detail-muted">No runs yet.</p>'}</aside></div></section>`;
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
