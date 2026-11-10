import type { Task } from './types.ts';
export const columns = [
  ['backlog', 'Backlog', 'draft'],
  ['discovery', 'Investigation & design', 'running'],
  ['approach', 'Approach approval', 'awaiting_plan'],
  ['progress', 'In progress', 'running'],
  ['review', 'In review', 'review'],
  ['final', 'Final approval', 'awaiting_final'],
  ['attention', 'Needs attention', 'blocked'],
  ['done', 'Done', 'completed'],
  ['finished', 'Completed', 'finished'],
  ['cancelled', 'Cancelled', 'cancelled'],
] as const;
export function taskLane(task: Task): string {
  const override = task.statusOverride;
  if (override) {
    const column = columns.find(([lane, , status]) =>
      override.lane ? lane === override.lane : status === override.value,
    );
    if (column) return column[0];
  }
  const known: Record<string, string> = {
    draft: 'backlog',
    awaiting_plan: 'approach',
    awaiting_final: 'final',
    completed: 'done',
    finished: 'finished',
    cancelled: 'cancelled',
    blocked: 'attention',
    paused: 'attention',
    manual: 'attention',
    interrupted: 'attention',
  };
  return (
    known[task.status] ||
    (task.stage === 'review'
      ? 'review'
      : ['implement', 'verify'].includes(task.stage || '')
        ? 'progress'
        : 'discovery')
  );
}
export function boardFilters(hash: string) {
  const q = new URLSearchParams(hash.split('?')[1]);
  return {
    query: q.get('q') || '',
    repository: q.get('repo') || '',
    layout: q.get('view') === 'list' ? ('list' as const) : ('board' as const),
  };
}
