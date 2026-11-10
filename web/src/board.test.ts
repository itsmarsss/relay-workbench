import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardFilters, taskLane } from './board.ts';
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
  });
});
