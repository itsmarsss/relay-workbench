import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardFilters, taskLane, filteredTasks } from './board.ts';
test('board overrides change presentation without advancing workflow gates', () => {
  const task = { id: 'x', title: 'Gate', status: 'awaiting_plan', stage: 'plan' };
  assert.equal(taskLane(task), 'approach');
  assert.equal(
    taskLane({ ...task, statusOverride: { value: 'finished', lane: 'finished' } }),
    'finished',
  );
  assert.equal(task.status, 'awaiting_plan');
  assert.equal(taskLane({ ...task, statusOverride: { value: 'unknown' } }), 'approach');
  assert.deepEqual(boardFilters('#tasks?q=fix+it&repo=abc&view=list'), {
    query: 'fix it',
    repository: 'abc',
    layout: 'list',
    scope: 'all',
    stage: '',
    sort: 'priority',
    showEmpty: false,
  });
});

test('task filters preserve views in URLs and reject unknown values', () => {
  assert.equal(boardFilters('#tasks').layout, 'list');
  assert.deepEqual(
    boardFilters('#tasks?view=board&scope=attention&stage=final&sort=recent&empty=1'),
    {
      query: '',
      repository: '',
      layout: 'board',
      scope: 'attention',
      stage: 'final',
      sort: 'recent',
      showEmpty: true,
    },
  );
  const invalid = boardFilters('#tasks?view=unknown&scope=unknown&stage=unknown&sort=unknown');
  assert.equal(invalid.layout, 'list');
  assert.equal(invalid.scope, 'all');
  assert.equal(invalid.stage, '');
  assert.equal(invalid.sort, 'priority');
});

test('task queue prioritizes decisions and searches every selected repository', () => {
  const tasks = [
    { id: 'done', title: 'Done', status: 'completed', updatedAt: '2026-01-04' },
    { id: 'draft', title: 'Draft', status: 'draft', updatedAt: '2026-01-03' },
    {
      id: 'running',
      title: 'Running',
      status: 'running',
      stage: 'implement',
      updatedAt: '2026-01-02',
    },
    {
      id: 'approval',
      title: 'Review',
      status: 'awaiting_final',
      updatedAt: '2026-01-01',
      repositories: [{ repository: { id: 'second', name: 'Secondary repo' } }],
    },
  ];
  const original = structuredClone(tasks);
  const filters = boardFilters('#tasks');
  assert.deepEqual(
    filteredTasks(tasks, filters).map((task) => task.id),
    ['approval', 'running', 'draft', 'done'],
  );
  assert.deepEqual(
    filteredTasks(tasks, { ...filters, scope: 'attention' }).map((task) => task.id),
    ['approval'],
  );
  assert.deepEqual(
    filteredTasks(tasks, { ...filters, query: 'SECONDARY', repository: 'second' }).map(
      (task) => task.id,
    ),
    ['approval'],
  );
  assert.deepEqual(
    filteredTasks(tasks, { ...filters, stage: 'progress' }).map((task) => task.id),
    ['running'],
  );
  assert.equal(
    filteredTasks(tasks, { ...filters, scope: 'attention', repository: 'missing' }).length,
    0,
  );
  assert.deepEqual(tasks, original, 'Filtering and sorting must not change workflow state');
});
