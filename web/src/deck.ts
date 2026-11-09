import type { TaskView } from './types';
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
export type Tab = { id: string; name: string; root: Node };
export type Deck = { tabs: Tab[]; active: string };
const views: TaskView[] = ['overview', 'thread', 'terminals', 'diff', 'handoffs', 'transcript'];
const id = () => crypto.randomUUID();
export const emptyPane = (): Pane => ({ type: 'pane', id: id(), taskId: '', view: 'overview' });
export function newDeck(): Deck {
  const tab = { id: id(), name: 'Workspace 1', root: emptyPane() };
  return { tabs: [tab], active: tab.id };
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
      return {
        id: tab.id,
        name:
          typeof tab.name === 'string' && tab.name.trim()
            ? tab.name.trim().slice(0, 60)
            : 'Workspace',
        root: decodeNode(tab.root, new Set()),
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
