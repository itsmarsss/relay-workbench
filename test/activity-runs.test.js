import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityRunSelection,
  activityRunNavigation,
  activityRunHeader,
} from '../public/activity-runs.js';

test('run selection follows new runs and keeps explicit historical selection', () => {
  const task = {
    attempts: [
      { id: 'old', stage: 'implement' },
      { id: 'new', stage: 'implement', role: 'verifier' },
    ],
  };
  const events = [
    { attemptId: 'old', summary: 'old' },
    { attemptId: 'new', summary: 'new' },
    { summary: 'task created' },
  ];
  assert.deepEqual(activityRunSelection(task, events).events, [events[1]]);
  assert.deepEqual(activityRunSelection(task, events, 'old').events, [events[0]]);
  assert.deepEqual(activityRunSelection(task, events, 'all').events, events);
  task.attempts.push({ id: 'next' });
  assert.equal(activityRunSelection(task, events).selected.id, 'next');
  assert.equal(activityRunSelection(task, events, 'old').selected.id, 'old');
});

test('run browser escapes context and keeps host output scoped to its run', () => {
  const run = { id: 'host', role: 'verifier', harness: 'checks', status: 'running' };
  const events = [
    { type: 'transcript', attemptId: 'other', text: 'unrelated output' },
    { type: 'transcript', attemptId: 'host', text: '<script>output</script>' },
  ];
  const html = activityRunHeader(run, events);
  assert.match(html, /&lt;script&gt;output/);
  assert.doesNotMatch(html, /unrelated output|<script>/);
  assert.match(html, /sandbox permissions stay the same/);
  assert.match(activityRunNavigation({ attempts: [run] }, run, 'latest'), /Configured checks/);
});
