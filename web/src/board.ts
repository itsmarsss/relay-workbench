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
    imported: 'done',
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
    layout: q.get('view') === 'board' ? ('board' as const) : ('list' as const),
    scope: taskScopes.some(([id]) => id === q.get('scope')) ? q.get('scope')! : 'all',
    stage: columns.some(([id]) => id === q.get('stage')) ? q.get('stage')! : '',
    sort: ['priority', 'recent', 'title'].includes(q.get('sort') || '')
      ? q.get('sort')!
      : 'priority',
    showEmpty: q.get('empty') === '1',
  };
}

export const taskScopes = [
  ['all', 'All tasks'],
  ['attention', 'Needs you'],
  ['active', 'Running'],
  ['backlog', 'Backlog'],
  ['done', 'Done'],
  ['finished', 'Completed'],
] as const;

export function inTaskScope(task: Task, scope: string) {
  const lane = taskLane(task);
  return (
    scope === 'all' ||
    (scope === 'attention'
      ? ['approach', 'final', 'attention'].includes(lane)
      : scope === 'active'
        ? ['discovery', 'progress', 'review'].includes(lane)
        : lane === scope)
  );
}

export function filteredTasks(tasks: Task[], filters: ReturnType<typeof boardFilters>) {
  const rank = (task: Task) =>
    inTaskScope(task, 'attention')
      ? 0
      : inTaskScope(task, 'active')
        ? 1
        : taskLane(task) === 'backlog'
          ? 2
          : 3;
  const updated = (task: Task) => Date.parse(task.updatedAt || '') || 0;
  return tasks
    .filter(
      (task) =>
        inTaskScope(task, filters.scope) &&
        (!filters.stage || taskLane(task) === filters.stage) &&
        (!filters.repository ||
          task.repository?.id === filters.repository ||
          task.repositories?.some((row) => row.repository?.id === filters.repository)) &&
        [
          task.title,
          task.repository?.name,
          ...(task.repositories || []).map((row) => row.repository?.name),
          task.id,
          task.ticket,
          task.latestSummary,
        ]
          .join(' ')
          .toLowerCase()
          .includes(filters.query.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        (filters.sort === 'title'
          ? a.title.localeCompare(b.title)
          : (filters.sort === 'priority' ? rank(a) - rank(b) : 0) || updated(b) - updated(a)) ||
        a.id.localeCompare(b.id),
    );
}
