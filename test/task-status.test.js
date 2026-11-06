import test from 'node:test';
import assert from 'node:assert/strict';
import { displayStatus } from '../public/task-status.js';
import { workflowColumn } from '../public/workflow.js';
import { filterTasks } from '../public/tasks.js';
import { publicationPanel } from '../public/publication.js';
test('publishing remains active and manual status controls board and filters', () => {
  const task = {
    id: 'a',
    title: 'A task',
    status: 'completed',
    stage: 'review',
    repository: { id: 'repo', name: 'Example' },
    delivery: { status: 'running', phase: 'verifying' },
  };
  assert.equal(displayStatus(task), 'publishing');
  assert.equal(workflowColumn(task), 'progress');
  const state = { filter: 'active', search: '', taskSort: 'recent' };
  assert.equal(filterTasks([task], state).length, 1);
  task.statusOverride = { value: 'review' };
  assert.equal(displayStatus(task), 'review');
  assert.equal(workflowColumn(task), 'review');
  task.statusOverride = { value: 'draft' };
  assert.equal(workflowColumn(task), 'backlog');
  assert.equal(task.status, 'completed');
});
test('PR tracker omits dashboard prose, duplicate stages and stale timestamps', () => {
  const html = publicationPanel({
    status: 'completed',
    repository: { id: 'repo', name: 'Example' },
    delivery: {
      id: 'run',
      status: 'running',
      phase: 'verifying',
      summary: 'Long agent output',
      requiresReverification: true,
    },
    publication: { checkedAt: '2026-01-01' },
  });
  assert.match(html, /Publishing…/);
  assert.match(html, /View run/);
  assert.doesNotMatch(
    html,
    /From accepted|DELIVERY|delivery-steps|Long agent output|Last checked|Retrying resumes/,
  );
});

test('status changes survive a pending server upgrade and sync when available', async () => {
  const { statusQueue } = await import('../public/pending-status.js');
  const values = new Map(),
    storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) };
  const queue = statusQueue(storage);
  queue.set('task', 'review');
  const restored = statusQueue(storage);
  assert.equal(restored.apply({ id: 'task', status: 'completed' }).statusOverride.value, 'review');
  await restored.sync(async () => {
    throw Error('Older server');
  }, 0);
  assert.equal(restored.apply({ id: 'task' }).statusOverride.pending, true);
  await restored.sync(async (path, method, body) => {
    assert.equal(body.value, 'review');
  }, 30001);
  assert.equal(restored.apply({ id: 'task' }).statusOverride, undefined);
});
