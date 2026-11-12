import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardFilters,
  taskLane,
  filteredTasks,
  foldedLanes,
  inTaskScope,
  toggleLane,
  boardOrder,
  placeCard,
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

test('placed cards keep their order and unplaced cards lead their stage', () => {
  const card = (id: string, updatedAt: string, boardRank?: number) => ({
    id,
    title: id,
    status: 'draft',
    stage: 'draft',
    updatedAt,
    boardRank,
  });
  const tasks = [
    card('a', '2026-01-01T00:00:00Z', 1),
    card('b', '2026-01-02T00:00:00Z', 0),
    card('c', '2026-01-03T00:00:00Z'),
    { ...card('d', '2026-01-04T00:00:00Z', 2), status: 'awaiting_plan', stage: 'plan' },
  ];
  const board = { ...boardFilters('#tasks?view=board'), layout: 'board' as const };
  const ids = (rows: { id: string }[]) => rows.map((task) => task.id);
  // Without placement the queue order is unchanged; with it, ranks decide and new work leads.
  assert.deepEqual(ids(filteredTasks(tasks, board)), ['d', 'c', 'b', 'a']);
  assert.deepEqual(ids(filteredTasks(tasks, board, true)), ['c', 'b', 'a', 'd']);
  assert.deepEqual(ids(filteredTasks(tasks, { ...board, sort: 'title' }, true)), [
    'a',
    'b',
    'c',
    'd',
  ]);
  assert.deepEqual(boardOrder(tasks), ['b', 'a', 'd']);
  // Dropping a card writes its whole stage as shown, so the unplaced card keeps its spot.
  assert.deepEqual(placeCard(tasks, 'a', 'backlog', 'c'), ['d', 'a', 'c', 'b']);
  assert.deepEqual(placeCard(tasks, 'c', 'backlog', null), ['d', 'b', 'a', 'c']);
  assert.deepEqual(placeCard(tasks, 'b', 'backlog', 'missing'), ['d', 'c', 'a', 'b']);
  // A card dragged in from another stage joins the target stage; its old stage is untouched.
  assert.deepEqual(placeCard(tasks, 'd', 'backlog', 'a'), ['c', 'b', 'd', 'a']);
  assert.deepEqual(placeCard(tasks, 'a', 'approach', 'd'), ['b', 'a', 'd']);
});
