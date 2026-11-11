import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardFilters,
  taskLane,
  filteredTasks,
  foldedLanes,
  inTaskScope,
  toggleLane,
} from './board.ts';
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
test('task views restore preferences while explicit URLs win', () => {
  const saved = { layout: 'board' as const, showEmpty: false };
  assert.equal(boardFilters('#tasks', saved).layout, 'board');
  assert.equal(boardFilters('#tasks', saved).showEmpty, false);
  assert.equal(boardFilters('#tasks?view=list&empty=1', saved).layout, 'list');
  assert.equal(boardFilters('#tasks?view=list&empty=1', saved).showEmpty, true);
  assert.equal(boardFilters('#tasks?view=board&empty=0').showEmpty, false);
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

test('parked tasks leave the attention queue without changing workflow status', () => {
  const task = { id: 'x', title: 'Later', status: 'blocked', stage: 'verify' };
  const parked = { ...task, statusOverride: { value: 'parked', lane: 'parked' } };
  assert.equal(taskLane(task), 'attention');
  assert.equal(taskLane(parked), 'parked');
  assert.equal(inTaskScope(parked, 'attention'), false);
  assert.equal(inTaskScope(parked, 'parked'), true);
  assert.equal(boardFilters('#tasks?scope=parked&stage=parked').scope, 'parked');
  assert.equal(boardFilters('#tasks?scope=parked&stage=parked').stage, 'parked');
  assert.equal(parked.status, 'blocked');
});

test('folded stages restore in board order and ignore unusable saved values', () => {
  assert.deepEqual(foldedLanes('["done","unknown","backlog","done"]'), ['backlog', 'done']);
  for (const saved of [null, '', 'not json', '{"done":true}', '"done"'])
    assert.deepEqual(foldedLanes(saved), []);
  assert.deepEqual(toggleLane(['backlog'], 'done'), ['backlog', 'done']);
  assert.deepEqual(toggleLane(['backlog', 'done'], 'backlog'), ['done']);
});
