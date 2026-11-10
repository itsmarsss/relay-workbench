import { asObject, asText } from './task-data.ts';
export type GraphNode = {
  id: string;
  x: number;
  y: number;
  lane: number;
  kind: 'run' | 'fork';
  row: Record<string, unknown>;
  checkpoints: { id: string; summary: string }[];
};
export type GraphEdge = { from: string; to: string; label: string; branch: boolean };
const time = (value: unknown) => Date.parse(asText(value)) || 0;
export function executionLayout(
  task: Record<string, unknown>,
  history?: {
    checkpoints?: { id: string; attemptId: string; summary: string }[];
    forks?: { taskId: string; attemptId: string; title: string; status: string }[];
  } | null,
) {
  const rows = [
    ...(Array.isArray(task.attempts) ? task.attempts : []),
    ...(Array.isArray(task.deliveryRuns) ? task.deliveryRuns : []),
  ]
    .map(asObject)
    .filter(
      (row): row is Record<string, unknown> => !!row && row.stage !== 'monitor' && !!asText(row.id),
    )
    .sort((a, b) => time(a.startedAt) - time(b.startedAt));
  const nodes: GraphNode[] = [],
    edges: GraphEdge[] = [],
    byId = new Map<string, GraphNode>(),
    occupied = new Set<string>();
  let previous: GraphNode | undefined;
  for (const row of rows) {
    const id = asText(row.id);
    if (byId.has(id)) continue;
    const parent = byId.get(asText(row.parentAttemptId)) || previous;
    const lane = row.role === 'debug' ? 1 : row.auxiliary ? 2 : 0;
    let column = parent ? Math.round((parent.x - 32) / 248) + 1 : 0;
    while (occupied.has(`${column}:${lane}`)) column++;
    const node: GraphNode = {
      id,
      x: 32 + column * 248,
      y: 46 + lane * 144,
      lane,
      kind: 'run',
      row,
      checkpoints: (history?.checkpoints || []).filter((c) => c.attemptId === id),
    };
    occupied.add(`${column}:${lane}`);
    nodes.push(node);
    byId.set(id, node);
    if (parent) {
      const repair =
        row.stage === 'implement' && ['verify', 'review'].includes(asText(parent.row.stage));
      edges.push({
        from: parent.id,
        to: id,
        label:
          row.role === 'debug'
            ? 'Diagnose'
            : parent.row.role === 'debug'
              ? 'Continue'
              : repair
                ? 'Repair'
                : row.stage === parent.row.stage
                  ? 'Retry'
                  : 'Handoff',
        branch: row.role === 'debug' || parent !== previous || repair,
      });
    }
    previous = node;
  }
  const forkCount = new Map<string, number>();
  for (const fork of history?.forks || []) {
    const parent = byId.get(fork.attemptId);
    if (!parent) continue;
    const lane = 3 + (forkCount.get(parent.id) || 0);
    forkCount.set(parent.id, lane - 2);
    let column = Math.round((parent.x - 32) / 248) + 1;
    while (occupied.has(`${column}:${lane}`)) column++;
    const node: GraphNode = {
      id: `fork-${fork.taskId}`,
      x: 32 + column * 248,
      y: 46 + lane * 144,
      lane,
      kind: 'fork',
      row: fork,
      checkpoints: [],
    };
    occupied.add(`${column}:${lane}`);
    nodes.push(node);
    byId.set(node.id, node);
    edges.push({ from: parent.id, to: node.id, label: 'Checkpoint branch', branch: true });
  }
  return {
    nodes,
    edges,
    byId,
    width: Math.max(680, ...nodes.map((n) => n.x + 250)),
    height: Math.max(210, ...nodes.map((n) => n.y + 134)),
  };
}
