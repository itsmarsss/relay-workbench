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

test('a queued status for a deleted task cannot block later task updates', async () => {
  const { statusQueue } = await import('../public/pending-status.js');
  const entries = new Map();
  const queue = statusQueue({
    getItem: (k) => entries.get(k),
    setItem: (k, v) => entries.set(k, v),
  });
  queue.set('deleted', 'review');
  queue.set('current', 'completed');
  const calls = [];
  await queue.sync(async (path) => {
    calls.push(path);
    if (path.includes('deleted')) throw Object.assign(Error('Not found'), { status: 404 });
  }, 0);
  assert.ok(calls.includes('/tasks/current/status-override'));
  assert.equal(queue.apply({ id: 'deleted' }).statusOverride, undefined);
  assert.equal(queue.apply({ id: 'current' }).statusOverride, undefined);
});

test('legacy status endpoint stays queued and per-task conflicts do not block other tasks', async () => {
  const { statusQueue } = await import('../public/pending-status.js');
  const queue = statusQueue({ getItem: () => null, setItem: () => {} });
  queue.set('legacy', 'review');
  await queue.sync(async (path) => {
    if (path.endsWith('/status-override'))
      throw Object.assign(Error('Older server'), { status: 404 });
  }, 0);
  assert.equal(queue.apply({ id: 'legacy' }).statusOverride.pending, true);
  queue.clear('legacy');
  queue.set('busy', 'running');
  queue.set('ready', 'completed');
  await queue.sync(async (path) => {
    if (path.includes('/busy/')) throw Object.assign(Error('Conflict'), { status: 409 });
  }, 1);
  assert.equal(queue.apply({ id: 'busy' }).statusOverride.pending, true);
  assert.equal(queue.apply({ id: 'ready' }).statusOverride, undefined);
});

test('a live follow-up belongs in active work until it finishes', () => {
  const task = {
    id: 'followup-task',
    title: 'Continue work',
    status: 'completed',
    stage: 'review',
    repository: { id: 'repo', name: 'Example' },
    deliveryRuns: [{ id: 'followup-run', stage: 'followup', status: 'running' }],
  };
  const state = { filter: 'active', search: '', taskSort: 'recent' };
  assert.equal(displayStatus(task), 'running');
  assert.equal(workflowColumn(task), 'progress');
  assert.equal(filterTasks([task], state).length, 1);
  const summary = { ...task, currentRun: { ...task.deliveryRuns[0] }, deliveryRuns: undefined };
  assert.equal(displayStatus(summary), 'running');
  assert.equal(filterTasks([summary], state).length, 1);
  task.deliveryRuns[0].status = 'complete';
  assert.equal(displayStatus(task), 'completed');
  assert.equal(filterTasks([task], state).length, 0);
});
