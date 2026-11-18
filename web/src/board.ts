import type { Task } from './types.ts';
// Exceptions that need a person lead; the rest follow workflow order.
export const columns = [
  ['attention', 'Needs attention', 'blocked'],
  ['backlog', 'Backlog', 'draft'],
  ['parked', 'Parked', 'parked'],
  ['discovery', 'Investigation & design', 'running'],
  ['approach', 'Approach approval', 'awaiting_plan'],
  ['progress', 'In progress', 'running'],
  ['review', 'In review', 'review'],
  ['final', 'Final approval', 'awaiting_final'],
  ['investigated', 'Investigated', 'completed'],
  ['done', 'Done', 'completed'],
  ['finished', 'Completed', 'finished'],
  ['cancelled', 'Cancelled', 'cancelled'],
] as const;
export const laneHints: Record<string, string> = {
  backlog: 'Ready when you are',
  parked: 'Set aside for later',
  discovery: 'Evidence and possible approaches',
  approach: 'Your decision before coding',
  progress: 'Implementation and verification',
  review: 'Independent agent review',
  final: 'Your final look',
  investigated: 'Findings ready, no code changed',
  done: 'Pipeline finished',
  finished: 'Work is fully finished',
  attention: 'Blocked, paused, or in your hands',
  cancelled: 'Retained for reference',
};
export function taskLane(task: Task): string {
  const override = task.statusOverride;
  if (override) {
    const column = columns.find(([lane, , status]) =>
      override.lane ? lane === override.lane : status === override.value && lane !== 'investigated',
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
  // An investigation that has reported back is finished as a workflow, but nothing was built:
  // it gets its own column so it is not read as delivered work.
  if (task.status === 'completed' && task.preset === 'investigate') return 'investigated';
  // Delivered work whose pull requests have all merged is fully finished, not waiting in Done.
  const pulls = task.pullRequests || [];
  if (task.status === 'completed' && pulls.length > 0 && pulls.every((pr) => pr.state === 'merged'))
    return 'finished';
  return (
    known[task.status] ||
    (task.stage === 'review'
      ? 'review'
      : ['implement', 'verify'].includes(task.stage || '')
        ? 'progress'
        : 'discovery')
  );
}
// Stages folded into a strip on the board. Saved ids that no longer name a column are dropped.
export function foldedLanes(saved: string | null): string[] {
  try {
    const ids: unknown = JSON.parse(saved || '[]');
    return Array.isArray(ids)
      ? columns.map(([lane]) => lane as string).filter((lane) => ids.includes(lane))
      : [];
  } catch {
    return [];
  }
}
export const toggleLane = (folded: string[], lane: string) =>
  folded.includes(lane) ? folded.filter((id) => id !== lane) : [...folded, lane];
export function boardFilters(
  hash: string,
  defaults: { layout?: 'list' | 'board'; showEmpty?: boolean } = {},
) {
  const q = new URLSearchParams(hash.split('?')[1]);
  return {
    query: q.get('q') || '',
    repository: q.get('repo') || '',
    layout: ['board', 'list'].includes(q.get('view') || '')
      ? (q.get('view') as 'board' | 'list')
      : defaults.layout || 'list',
    scope: taskScopes.some(([id]) => id === q.get('scope')) ? q.get('scope')! : 'all',
    stage: columns.some(([id]) => id === q.get('stage')) ? q.get('stage')! : '',
    sort: ['priority', 'recent', 'title'].includes(q.get('sort') || '')
      ? q.get('sort')!
      : 'priority',
    showEmpty: q.has('empty') ? q.get('empty') === '1' : (defaults.showEmpty ?? false),
  };
}

export const taskScopes = [
  ['all', 'All tasks'],
  ['attention', 'Needs you'],
  ['active', 'Running'],
  ['backlog', 'Backlog'],
  ['parked', 'Parked'],
  ['investigated', 'Investigated'],
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

// With `placed`, cards the user dragged keep their place under the default sort. Cards never
// placed lead, so new work shows up at the top of its stage.
export function filteredTasks(
  tasks: Task[],
  filters: ReturnType<typeof boardFilters>,
  placed = false,
) {
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
    .sort((a, b) => {
      if (placed && filters.sort === 'priority' && (a.boardRank != null || b.boardRank != null))
        return a.boardRank == null ? -1 : b.boardRank == null ? 1 : a.boardRank - b.boardRank;
      return (
        (filters.sort === 'title'
          ? a.title.localeCompare(b.title)
          : (filters.sort === 'priority' ? rank(a) - rank(b) : 0) || updated(b) - updated(a)) ||
        a.id.localeCompare(b.id)
      );
    });
}
const everything = { ...boardFilters(''), layout: 'board' as const };
// Ids of the cards the user has placed, in the order they hold on the board.
export const boardOrder = (tasks: Task[]) =>
  filteredTasks(tasks, everything, true)
    .filter((task) => task.boardRank != null)
    .map((task) => task.id);
// The order to save after dropping a card into `lane` ahead of `before`, or at the end. The whole
// stage is written out as it is shown, hidden cards included, so every card in it keeps its place.
export function placeCard(tasks: Task[], id: string, lane: string, before: string | null) {
  const shown = filteredTasks(tasks, everything, true);
  const stage = shown.filter((task) => taskLane(task) === lane && task.id !== id).map((t) => t.id);
  const at = before === null ? -1 : stage.indexOf(before);
  stage.splice(at < 0 ? stage.length : at, 0, id);
  return [
    ...shown.filter((task) => task.boardRank != null && !stage.includes(task.id)).map((t) => t.id),
    ...stage,
  ];
}
