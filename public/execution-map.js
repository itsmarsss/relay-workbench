import { feedbackSummary } from './publication.js';
import { taskRuns } from './task-runs.js';
import { runLabel } from './run-label.js';
import { e, stageNames, harnessBadge, icon } from './ui.js';
import { runState, harnessName, runTiming } from './run-presentation.js';
import { timer } from './live-progress.js';
export function executionNodes(task) {
  const extras = [];
  for (const point of task.history?.checkpoints ?? [])
    extras.push({
      id: `checkpoint-${point.id}`,
      checkpointId: point.id,
      parentAttemptId: point.attemptId,
      stage: 'checkpoint',
      role: 'history',
      harness: 'relay',
      status: 'complete',
      startedAt: point.at,
      finishedAt: point.at,
      relation: 'Saved checkpoint',
      handoff: { summary: point.summary },
    });
  for (const event of task.history?.decisions ?? [])
    extras.push({
      id: event.id,
      parentAttemptId: event.parentAttemptId,
      stage: 'auto',
      role: 'history',
      harness: 'relay',
      status: 'complete',
      startedAt: event.at,
      finishedAt: event.at,
      relation: 'Automatic decision',
      handoff: { summary: event.summary, details: `Authorized scope: ${event.scope}` },
    });
  for (const fork of task.history?.forks ?? [])
    extras.push({
      id: `fork-${fork.taskId}`,
      parentAttemptId: `checkpoint-${fork.checkpointId}`,
      stage: 'fork',
      role: 'history',
      harness: 'relay',
      status:
        fork.status === 'failed' ? 'failed' : fork.status === 'preparing' ? 'running' : 'complete',
      startedAt: fork.at,
      finishedAt: fork.at,
      relation: 'Alternate continuation',
      targetTaskId: fork.taskId,
      handoff: {
        summary:
          fork.status === 'failed'
            ? 'Continuation restore failed. Inspect the preserved workspace.'
            : fork.status === 'preparing'
              ? 'Restoring the continuation workspace.'
              : `Separate continuation${fork.mode === 'approach' ? ' to choose another approach' : fork.mode === 'decision' ? ' to revisit a debugger decision' : ` at ${fork.stage}`}. Original work preserved.`,
      },
    });
  if (task.fork)
    extras.push({
      id: task.fork.nodeId,
      parentAttemptId: task.fork.sourceAttemptId,
      stage: 'fork',
      role: 'history',
      harness: 'relay',
      status:
        task.checkpointRestore?.status === 'failed'
          ? 'failed'
          : task.checkpointRestore?.status === 'preparing'
            ? 'running'
            : 'complete',
      startedAt: task.fork.at,
      finishedAt: task.fork.at,
      relation:
        task.checkpointRestore?.status === 'failed'
          ? 'Restore failed'
          : task.checkpointRestore?.status === 'preparing'
            ? 'Restoring checkpoint'
            : 'Restored checkpoint',
      targetTaskId: task.fork.sourceTaskId,
      handoff: {
        summary:
          task.checkpointRestore?.status === 'failed'
            ? 'Checkpoint restore failed. Inspect the preserved workspace.'
            : task.checkpointRestore?.status === 'preparing'
              ? 'Restoring the continuation workspace.'
              : task.fork.mode === 'approach'
                ? 'Saved plan reopened for another implementation choice. Earlier investigation preserved.'
                : task.fork.mode === 'decision'
                  ? 'Saved debugger decision reopened. Earlier work and diagnosis preserved.'
                  : 'Continued from a saved checkpoint in new worktrees. Verification and acceptance reset.',
      },
    });
  const attempts = [...taskRuns(task), ...extras].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
  );
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
  node.role === 'history'
    ? 'history'
    : node.role === 'debug'
      ? 'debug'
      : node.role === 'verifier' || node.harness === 'checks'
        ? 'verify'
        : 'workflow';
const laneNames = {
  history: 'Decisions & checkpoints',
  workflow: 'Workflow',
  debug: 'Debugging',
  verify: 'Verification',
};
export function graphLayout(task) {
  const runs = executionNodes(task);
  const lanes = ['workflow', 'debug', 'verify', 'history']
    .filter((key) => runs.some((n) => laneFor(n) === key))
    .map((key, index) => ({ key, label: laneNames[key], x: 32 + index * 300, y: 30 }));
  const occupied = new Set();
  const nodes = [];
  for (const run of runs) {
    // Only preceding runs can be causal parents. Unknown legacy links remain inferred.
    const parent = nodes.find((n) => n.number === run.parentNumber);
    const lane = laneFor(run);
    let row = parent ? parent.row + 1 : 0;
    while (occupied.has(`${lane}:${row}`)) row++;
    occupied.add(`${lane}:${row}`);
    nodes.push({ ...run, lane, row, x: lanes.find((l) => l.key === lane).x, y: 74 + row * 176 });
  }
  const edges = nodes
    .filter((n) => n.parentNumber)
    .flatMap((node) => {
      const parent = nodes.find((n) => n.number === node.parentNumber && n.number < node.number);
      if (!parent) return [];
      const sx = parent.x + 116,
        sy = parent.y + 112,
        ex = node.x + 116,
        ey = node.y;
      const midY = sy + (ey - sy) / 2;
      // Long links use the lane's gutter instead of passing through intervening cards.
      const path =
        parent.lane === node.lane && node.row > parent.row + 1
          ? `M ${sx} ${sy} L ${sx} ${sy + 18} L ${parent.x - 18} ${sy + 18} L ${parent.x - 18} ${ey - 18} L ${ex} ${ey - 18} L ${ex} ${ey}`
          : `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`;
      return [
        {
          from: parent.number,
          to: node.number,
          inferred: node.inferred,
          relation: node.relation,
          path,
          labelX: (sx + ex) / 2,
          labelY: midY,
        },
      ];
    });
  return {
    nodes,
    edges,
    lanes,
    width: Math.max(340, lanes.length * 300 - 4),
    height: Math.max(260, ...nodes.map((n) => n.y + 156)),
  };
}
// Pan only the graph viewport; scrolling a node into view can also move the page.
export function focusGraphNode(root = document) {
  const viewport = root.querySelector('.node-graph-scroll');
  const node = root.querySelector('.graph-node.selected');
  if (!viewport || !node) return;
  const view = viewport.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  viewport.scrollTo({
    left: viewport.scrollLeft + box.left - view.left - (viewport.clientWidth - box.width) / 2,
    top: viewport.scrollTop + box.top - view.top - (viewport.clientHeight - box.height) / 2,
    behavior: viewport.ownerDocument.documentElement.hasAttribute('data-low-motion')
      ? 'instant'
      : 'smooth',
  });
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
  const ancestors = new Set();
  let cursor = selected;
  while (cursor && !ancestors.has(cursor.number)) {
    ancestors.add(cursor.number);
    cursor = nodes.find((n) => n.number === cursor.parentNumber);
  }
  const canvas = `<div class="graph-canvas"><div class="graph-canvas-caption"><span>Execution path <span class="graph-flow-direction">↓</span></span><small><i class="graph-link-key"></i> Handoff <i class="graph-link-key inferred"></i> Recorded order</small></div><div class="node-graph-scroll" tabindex="0" aria-label="Scrollable execution graph"><svg class="node-graph" width="${width * zoom}" height="${height * zoom}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Task runs and their connected execution paths"><defs><marker id="execution-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1L8 5L1 9" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker></defs>${lanes.map((lane) => `<rect class="graph-lane" x="${lane.x - 12}" y="54" width="256" height="${height - 70}" rx="16"/><text x="${lane.x + 116}" y="${lane.y}" text-anchor="middle" class="graph-lane-title">${e(lane.label)}</text>`).join('')}${edges.map((edge) => `<g class="graph-connection ${ancestors.has(edge.from) && ancestors.has(edge.to) ? 'on-path' : ''}"><path class="graph-edge ${edge.inferred ? 'inferred' : ''}" d="${edge.path}" marker-end="url(#execution-arrow)"><title>${edge.inferred ? 'Recorded order: ' : ''}${e(edge.relation)} · ${edge.from} → ${edge.to}</title></path>${nodes[edge.from - 1].lane !== nodes[edge.to - 1].lane ? `<rect class="graph-edge-label-bg" x="${edge.labelX - 38}" y="${edge.labelY - 10}" width="76" height="20" rx="10"/><text class="graph-edge-label" x="${edge.labelX}" y="${edge.labelY + 4}" text-anchor="middle">${nodes[edge.to - 1].lane === 'debug' ? 'Diagnose' : nodes[edge.to - 1].lane === 'verify' ? 'Verify' : 'Continue'}</text>` : ''}</g>`).join('')}${nodes.map((node) => `<g class="graph-node ${node.lane === 'debug' ? 'debug-branch' : node.lane === 'verify' ? 'checks-branch' : ''} ${node.status === 'running' ? 'is-running' : ''} ${['blocked', 'failed'].includes(runState(node).key) ? 'is-blocked' : ''} ${ancestors.has(node.number) ? 'on-path' : ''} ${selected?.id === node.id ? 'selected' : ''}" transform="translate(${node.x} ${node.y})" role="button" tabindex="0" aria-pressed="${selected?.id === node.id}" aria-label="Run ${node.number}: ${e(runLabel(node))}, ${e(status(node))}" data-action="graph-select" data-id="${e(node.id)}"><rect class="graph-card" width="232" height="112" rx="12"/><circle cx="18" cy="22" r="3.5" class="graph-status-dot ${e(runState(node).key)}"/><text x="28" y="26" class="graph-node-status">${e(short(status(node), 25))}</text><text x="216" y="26" text-anchor="end" class="graph-node-number">#${node.number}</text><text x="14" y="56" class="graph-node-title">${e(short(runLabel(node), 28))}</text><path class="graph-card-divider" d="M14 70H218"/><foreignObject x="14" y="80" width="20" height="20"><div xmlns="http://www.w3.org/1999/xhtml" class="graph-brand">${harnessBadge(node.harness)}</div></foreignObject><text x="42" y="94" class="graph-node-meta">${e(harnessName(node.harness))}</text>${node.parentNumber && node.lane !== nodes[node.parentNumber - 1]?.lane ? `<text x="216" y="94" text-anchor="end" class="graph-node-origin">↳ #${node.parentNumber}</text>` : ''}<title>${e(node.relation)}${node.handoff ? `: ${e(node.handoff.summary)}` : ''}</title></g>`).join('')}</svg>${!nodes.length ? '<p class="graph-empty">Start the workflow to see its execution path.</p>' : ''}</div></div>`;
  return `<section class="execution-map graph-dialog" role="dialog" aria-modal="true" aria-label="Execution graph"><header class="graph-header"><div><span class="detail-kicker">WORKFLOW HISTORY</span><h2>Execution graph <span class="graph-run-count">${nodes.length} steps</span></h2></div><div class="graph-toolbar"><button class="btn secondary small" data-action="graph-current">Latest run</button><div class="graph-zoom-controls"><button class="btn text small" data-action="graph-zoom-out" aria-label="Zoom out">−</button><button class="btn text small" data-action="graph-reset" aria-label="Reset zoom">${Math.round(zoom * 100)}%</button><button class="btn text small" data-action="graph-zoom-in" aria-label="Zoom in">+</button></div><button class="btn text small" data-action="graph-fit" title="Show the whole execution graph">Fit view</button><button class="btn text small" data-action="graph-focus" title="Center the selected run at readable size">Readable view</button><button class="btn text small graph-close" data-action="close-execution-map" aria-label="Close execution graph">✕</button></div></header><div class="graph-body">${canvas}<aside class="graph-inspector">${selected ? `<div class="graph-inspector-heading"><span class="detail-kicker">STEP ${selected.number}</span><span class="run-status ${e(runState(selected).key)}">${e(status(selected))}</span></div><nav class="graph-run-navigation" aria-label="Browse graph runs"><button class="btn text small" data-action="graph-select" data-id="${e(nodes[selected.number - 2]?.id ?? '')}" aria-label="Previous run" ${selected.number <= 1 ? 'disabled' : ''}>${icon('chevron', 'previous-run-icon')}</button><span>Step ${selected.number} of ${nodes.length}</span><button class="btn text small" data-action="graph-select" data-id="${e(nodes[selected.number]?.id ?? '')}" aria-label="Next run" ${selected.number >= nodes.length ? 'disabled' : ''}>${icon('chevron')}</button></nav><div class="graph-inspector-title">${harnessBadge(selected.harness)}<h3>${e(runLabel(selected))}</h3></div><p class="graph-run-summary">${e(selected.handoff?.summary || selected.error || 'Output and evidence appear as this run progresses.')}</p>${selected.checkpointId ? `<button class="btn secondary small" data-action="fork-checkpoint" data-checkpoint="${e(selected.checkpointId)}">Continue from checkpoint</button>` : ''}${selected.targetTaskId ? `<a class="btn secondary small" href="#task/${e(selected.targetTaskId)}/overview">Open linked workflow ↗</a>` : ''}${selected.inherited ? `<a class="btn secondary small" href="#task/${e(selected.originTaskId ?? task.fork?.sourceTaskId)}/thread" data-action="graph-open-activity" data-task-id="${e(selected.originTaskId ?? task.fork?.sourceTaskId)}" data-id="${e(selected.id)}">View original activity ↗</a>` : selected.role !== 'history' ? `<button class="btn secondary small graph-open-run" data-action="graph-open-activity" data-id="${e(selected.id)}">Open run activity ↗</button>` : ''}<dl class="detail-facts graph-facts">${selected.role === 'history' ? `<div><dt>Recorded</dt><dd>${e(new Date(selected.startedAt).toLocaleString())}</dd></div>` : `<div><dt>Agent</dt><dd>${e(harnessName(selected.harness))}</dd></div><div><dt>Model</dt><dd>${e(selected.actualModel || selected.model || (selected.harness === 'checks' ? 'Configured commands' : 'CLI default · not reported'))}</dd></div><div><dt>Duration</dt><dd>${runTiming(selected) || 'Not started'}</dd></div>`}<div><dt>Handoff</dt><dd>${e(selected.relation)}${selected.parentNumber ? `<small>From run ${selected.parentNumber}</small>` : ''}</dd></div></dl>${selected.stage === 'publish' ? (task.repositories?.length > 1 ? task.repositories.filter((entry) => !selected.repositoryId || entry.repository.id === selected.repositoryId) : [task]).map((entry) => `<section class="graph-publication-feedback">${task.repositories?.length > 1 ? `<h4>${e(entry.repository.name)}</h4>` : ''}${feedbackSummary(entry, { controls: false })}</section>`).join('') : ''}${selected.handoff?.evidence?.length ? `<details class="detail-disclosure"><summary>Evidence <span>${selected.handoff.evidence.length}</span></summary><ul class="graph-evidence">${selected.handoff.evidence.map((v) => `<li>${e(v)}</li>`).join('')}</ul></details>` : ''}${selected.handoff?.details ? `<details class="detail-disclosure"><summary>Full handoff</summary><p class="graph-handoff">${e(selected.handoff.details)}</p></details>` : ''}` : '<p class="detail-muted">No runs yet.</p>'}</aside></div></section>`;
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
