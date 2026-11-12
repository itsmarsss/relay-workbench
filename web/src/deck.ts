import { inTaskScope } from './board.ts';
import type { Task, TaskView } from './types.ts';
export type Pane = { type: 'pane'; id: string; taskId: string; view: TaskView };
export type Split = {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  first: Node;
  second: Node;
};
export type Node = Pane | Split;
export type Tab = {
  id: string;
  name: string;
  root: Node;
  layout?: 'grid' | 'split';
  columns?: 1 | 2 | 3 | 4;
  density?: 'auto' | 'fixed';
  // 'live' follows current work on its own; 'pinned' shows only panes chosen by hand.
  mode?: 'live' | 'pinned';
};
export type Deck = { tabs: Tab[]; active: string };
const views: TaskView[] = ['overview', 'thread', 'terminals', 'diff', 'handoffs', 'transcript'];
const id = () => crypto.randomUUID();
export const emptyPane = (): Pane => ({ type: 'pane', id: id(), taskId: '', view: 'overview' });
export function newDeck(): Deck {
  const tab: Tab = {
    id: id(),
    name: 'Workspace 1',
    root: emptyPane(),
    layout: 'grid',
    columns: 3,
    density: 'auto',
    mode: 'live',
  };
  return { tabs: [tab], active: tab.id };
}
// The same test the overview, inbox and board use, so a task moved to Done on the board stops
// counting here too.
export const needsDecision = (task: Task) => inTaskScope(task, 'attention');
export const isLive = (task: Task) =>
  task.currentRun?.status === 'running' ||
  (task.status === 'running' &&
    !['completed', 'complete', 'failed', 'cancelled'].includes(task.currentRun?.status || ''));
// What a live deck shows without any setup: decisions first, then running work, then a
// short tail of recent tasks so the deck is never blank while work exists.
// With `include`, that task is shown even when it would not make the short tail.
export function liveGroups(tasks: Task[], tail = 6, include = '') {
  const updated = (task: Task) => Date.parse(task.updatedAt || '') || 0;
  const recent = (a: Task, b: Task) => updated(b) - updated(a) || a.id.localeCompare(b.id);
  const needs = tasks.filter(needsDecision).sort(recent);
  const running = tasks.filter((task) => !needsDecision(task) && isLive(task)).sort(recent);
  const rest = tasks
    .filter(
      (task) =>
        !needsDecision(task) && !isLive(task) && !['cancelled', 'finished'].includes(task.status),
    )
    .sort(recent)
    .filter((task, index) => index < tail || task.id === include);
  return (
    [
      ['needs', 'Needs you', needs],
      ['running', 'Running', running],
      ['recent', 'Recently updated', rest],
    ] as const
  ).filter(([, , rows]) => rows.length > 0);
}
export function panes(node: Node): Pane[] {
  return node.type === 'pane' ? [node] : [...panes(node.first), ...panes(node.second)];
}
export function minimumSize(node: Node): { width: number; height: number } {
  if (node.type === 'pane') return { width: 280, height: 250 };
  const first = minimumSize(node.first),
    second = minimumSize(node.second);
  return node.direction === 'horizontal'
    ? { width: first.width + second.width + 8, height: Math.max(first.height, second.height) }
    : { width: Math.max(first.width, second.width), height: first.height + second.height + 8 };
}
export function updateNode(node: Node, target: string, change: (node: Node) => Node): Node {
  if (node.id === target) return change(node);
  return node.type === 'pane'
    ? node
    : {
        ...node,
        first: updateNode(node.first, target, change),
        second: updateNode(node.second, target, change),
      };
}
export function removeNode(node: Node, target: string): Node {
  if (node.type === 'pane') return node.id === target ? emptyPane() : node;
  if (node.first.id === target) return node.second;
  if (node.second.id === target) return node.first;
  return {
    ...node,
    first: removeNode(node.first, target),
    second: removeNode(node.second, target),
  };
}
export function splitNode(node: Node, target: string, direction: Split['direction']): Node {
  if (panes(node).length >= 8) return node;
  return updateNode(node, target, (child) =>
    child.type !== 'pane'
      ? child
      : { type: 'split', id: id(), direction, ratio: 50, first: child, second: emptyPane() },
  );
}
export function addPane(node: Node, taskId = ''): Node {
  const empty = panes(node).find((pane) => !pane.taskId);
  if (empty) return updateNode(node, empty.id, (pane) => ({ ...pane, taskId }) as Pane);
  if (panes(node).length >= 8) return node;
  return {
    type: 'split',
    id: id(),
    direction: 'horizontal',
    ratio: 50,
    first: node,
    second: { ...emptyPane(), taskId },
  };
}
// Fills a deck with the given tasks, at most eight, replacing its current panes.
export function seedPanes(taskIds: string[]): Node {
  return taskIds.slice(0, 8).reduce<Node>((root, taskId) => addPane(root, taskId), emptyPane());
}
export function movePane(node: Node, from: string, to: string): Node {
  const items = panes(node),
    source = items.findIndex((pane) => pane.id === from),
    target = items.findIndex((pane) => pane.id === to);
  if (source < 0 || target < 0 || source === target) return node;
  const [item] = items.splice(source, 1);
  items.splice(target, 0, item!);
  let index = 0;
  function arrange(current: Node): Node {
    return current.type === 'pane'
      ? items[index++]!
      : { ...current, first: arrange(current.first), second: arrange(current.second) };
  }
  return arrange(node);
}
function decodeNode(value: unknown, ids: Set<string>, depth = 0): Node {
  if (!value || typeof value !== 'object' || depth > 8 || ids.size >= 15)
    throw new Error('Invalid layout');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.id) || ids.has(v.id))
    throw new Error('Invalid node ID');
  ids.add(v.id);
  if (v.type === 'pane')
    return {
      type: 'pane',
      id: v.id,
      taskId: typeof v.taskId === 'string' && /^[a-f0-9-]{36}$/.test(v.taskId) ? v.taskId : '',
      view: views.includes(v.view as TaskView) ? (v.view as TaskView) : 'overview',
    };
  if (v.type !== 'split' || !['horizontal', 'vertical'].includes(String(v.direction)))
    throw new Error('Invalid split');
  return {
    type: 'split',
    id: v.id,
    direction: v.direction as Split['direction'],
    ratio:
      typeof v.ratio === 'number' && Number.isFinite(v.ratio)
        ? Math.max(20, Math.min(80, v.ratio))
        : 50,
    first: decodeNode(v.first, ids, depth + 1),
    second: decodeNode(v.second, ids, depth + 1),
  };
}
export function parseDeck(value: string | null): Deck {
  try {
    const parsed: unknown = JSON.parse(value || 'null');
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid layout');
    const data = parsed as Record<string, unknown>;
    if (!Array.isArray(data.tabs) || !data.tabs.length || data.tabs.length > 10)
      throw new Error('Invalid tabs');
    const ids = new Set<string>();
    const tabs: Tab[] = data.tabs.map((input: unknown) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid tab');
      const tab = input as Record<string, unknown>;
      if (typeof tab.id !== 'string' || !/^[a-f0-9-]{36}$/.test(tab.id) || ids.has(tab.id))
        throw new Error('Invalid tab ID');
      ids.add(tab.id);
      const root = decodeNode(tab.root, new Set());
      return {
        id: tab.id,
        name:
          typeof tab.name === 'string' && tab.name.trim()
            ? tab.name.trim().slice(0, 60)
            : 'Workspace',
        root,
        layout: tab.layout === 'split' ? 'split' : 'grid',
        columns: tab.columns === 1 || tab.columns === 3 || tab.columns === 4 ? tab.columns : 2,
        density: tab.density === 'fixed' ? 'fixed' : 'auto',
        // Layouts saved before live decks stay pinned only when something was placed.
        mode:
          tab.mode === 'live' || tab.mode === 'pinned'
            ? tab.mode
            : tab.layout === 'split' || panes(root).some((pane) => pane.taskId)
              ? 'pinned'
              : 'live',
      };
    });
    return {
      tabs,
      active: typeof data.active === 'string' && ids.has(data.active) ? data.active : tabs[0]!.id,
    };
  } catch {
    return newDeck();
  }
}
