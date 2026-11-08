const defaults = {
  filter: 'all',
  repositoryFilter: '',
  stageFilter: '',
  taskSort: 'priority',
  search: '',
  showEmptyStages: false,
};
const keys = {
  filter: 'scope',
  repositoryFilter: 'repo',
  stageFilter: 'stage',
  taskSort: 'sort',
  search: 'q',
  taskLayout: 'layout',
  showEmptyStages: 'empty',
};
export function readTaskFilters(hash) {
  const query = new URLSearchParams(hash.split('?')[1]);
  const result = { ...defaults };
  for (const [field, key] of Object.entries(keys)) {
    if (query.has(key))
      result[field] = field === 'showEmptyStages' ? query.get(key) === '1' : query.get(key);
  }
  if (!['all', 'attention', 'active', 'backlog', 'completed', 'cancelled'].includes(result.filter))
    result.filter = 'all';
  if (result.taskLayout && !['board', 'list'].includes(result.taskLayout)) delete result.taskLayout;
  if (!['priority', 'recent', 'created', 'title'].includes(result.taskSort))
    result.taskSort = 'priority';
  return result;
}
export function writeTaskFilters(state) {
  if (location.hash.split('?')[0] !== '#tasks') return;
  const query = new URLSearchParams();
  for (const [field, key] of Object.entries(keys)) {
    const value = state[field];
    if (value && value !== defaults[field]) query.set(key, value === true ? '1' : value);
  }
  const hash = '#tasks' + (query.size ? '?' + query : '');
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
