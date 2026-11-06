import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityRunSelection,
  activityRunNavigation,
  activityRunHeader,
  activityEventIdentity,
  activityEventMeta,
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

test('system updates retain harness context without impersonating agents', () => {
  for (const type of ['stage_started', 'terminal', 'blocked', 'recovery', 'manual']) {
    assert.deepEqual(activityEventIdentity({ type, harness: 'codex' }), {
      name: 'Relay',
      harness: null,
      context: 'Codex',
    });
  }
  for (const type of ['activity', 'handoff']) {
    assert.equal(activityEventIdentity({ type, harness: 'claude' }).name, 'Claude');
  }
  assert.equal(
    activityEventIdentity({ type: 'activity', source: 'relay', harness: 'codex' }).name,
    'Relay',
  );
  assert.equal(activityEventIdentity({ type: 'feedback', harness: 'codex' }).name, 'You');
  assert.equal(activityEventIdentity({ type: 'activity', harness: 'checks' }).name, 'Relay');
  assert.match(
    activityEventMeta({ type: 'terminal', harness: 'codex' }, 'Investigation'),
    /<strong>Relay<\/strong><span>Codex<\/span><span>Investigation<\/span>/,
  );
});
