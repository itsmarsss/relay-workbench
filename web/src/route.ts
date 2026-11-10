import { taskViews, type TaskView } from './types.ts';
export type Route =
  | { kind: 'deck' }
  | { kind: 'tasks' }
  | { kind: 'repositories' }
  | { kind: 'storage' }
  | { kind: 'settings' }
  | { kind: 'memory' }
  | { kind: 'inbox' }
  | { kind: 'relay' }
  | { kind: 'task'; id: string; tab: TaskView };
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0] || 'deck';
  const match = path.match(/^task\/([a-f0-9-]{36})(?:\/([a-z]+))?$/);
  if (match)
    return {
      kind: 'task',
      id: match[1]!,
      tab: taskViews.some((view) => view.id === match[2]) ? (match[2] as TaskView) : 'overview',
    };
  if (
    path === 'tasks' ||
    path === 'repositories' ||
    path === 'storage' ||
    path === 'settings' ||
    path === 'memory' ||
    path === 'inbox' ||
    path === 'relay'
  )
    return { kind: path };
  return { kind: 'deck' };
}
