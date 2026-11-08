import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityRunSelection,
  activityRunNavigation,
  activityRunHeader,
  activityEventIdentity,
  activityEventMeta,
  activityPassoff,
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
  assert.match(html, /All workflow agents use host execution/);
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

test('delivery runs follow publication and retain prior retries and scoped output', async () => {
  const { taskRuns } = await import('../public/task-runs.js');
  const { terminalSessions } = await import('../public/terminals.js');
  const { executionNodes } = await import('../public/execution-map.js');
  const task = {
    status: 'completed',
    repository: { id: 'repo', name: 'Example' },
    attempts: [
      { id: 'review', stage: 'review', harness: 'claude', startedAt: '2026-01-01T00:00:00Z' },
    ],
    deliveryRuns: [
      {
        id: 'first',
        stage: 'publish',
        status: 'blocked',
        harness: 'codex',
        startedAt: '2026-01-01T01:00:00Z',
        terminal: { session: 'first' },
      },
    ],
    delivery: {
      id: 'retry',
      status: 'running',
      harness: 'codex',
      startedAt: '2026-01-01T02:00:00Z',
      terminal: { session: 'retry' },
    },
  };
  const events = [
    { attemptId: 'first', summary: 'Old blocker' },
    { attemptId: 'retry', summary: 'Inspecting remote' },
  ];
  assert.equal(activityRunSelection(task, events).selected.id, 'retry');
  assert.deepEqual(activityRunSelection(task, events, 'first').events, [events[0]]);
  assert.equal(taskRuns(task).length, 3);
  assert.match(activityRunNavigation(task, taskRuns(task).at(-1), 'latest'), /Publish/);
  assert.equal(terminalSessions(task).length, 2);
  assert.equal(terminalSessions(task).at(-1).live, true);
  assert.equal(executionNodes(task).at(-1).stage, 'publish');
});

test('routine PR polls do not become workflow runs or take over current activity', async () => {
  const { taskRuns } = await import('../public/task-runs.js');
  const { terminalSessions, terminalSelection } = await import('../public/terminals.js');
  const { executionNodes } = await import('../public/execution-map.js');
  const task = {
    status: 'completed',
    repository: { id: 'repo', name: 'Example' },
    attempts: [
      {
        id: 'repair',
        stage: 'implement',
        startedAt: '2026-01-01T00:00:00Z',
        harness: 'codex',
        terminal: { session: 'repair' },
        status: 'complete',
      },
    ],
    deliveryRuns: [
      {
        id: 'published',
        stage: 'publish',
        startedAt: '2026-01-01T01:00:00Z',
        harness: 'codex',
        terminal: { session: 'published' },
        status: 'complete',
      },
      ...['old-poll', 'poll'].map((id, i) => ({
        id,
        stage: 'monitor',
        startedAt: `2026-01-01T0${i + 2}:00:00Z`,
        harness: 'codex',
        status: 'complete',
        terminal: { session: id },
      })),
    ],
    publicationMonitor: {
      attemptId: 'poll',
      startedAt: '2026-01-01T03:00:00Z',
      harness: 'codex',
      status: 'running',
      terminal: { session: 'poll' },
    },
  };
  const events = [
    { attemptId: 'published', type: 'handoff', summary: 'Published' },
    { attemptId: 'poll', stage: 'monitor', type: 'activity', summary: 'Polling' },
    {
      attemptId: 'poll',
      stage: 'monitor',
      type: 'publication',
      observationChange: true,
      summary: 'Checks passing',
    },
  ];
  assert.deepEqual(
    taskRuns(task).map((r) => r.id),
    ['repair', 'published'],
  );
  assert.equal(taskRuns(task, { includeMonitoring: true }).length, 4);
  assert.equal(activityRunSelection(task, events).selected.id, 'published');
  assert.deepEqual(activityRunSelection(task, events, 'all').events, [events[0], events[2]]);
  assert.doesNotMatch(
    activityRunNavigation(task, null, 'latest'),
    /data-run="poll"|data-run="old-poll"/,
  );
  assert.deepEqual(
    executionNodes(task).map((r) => r.id),
    ['repair', 'published'],
  );
  assert.deepEqual(
    terminalSessions(task).map((r) => r.id),
    ['repair', 'published', 'poll'],
  );
  assert.equal(terminalSelection(task).id, 'published');
  assert.equal(terminalSelection(task, 'poll').id, 'poll');
});

test('passoff markers show historical transitions but never concurrent runs', () => {
  const task = {
    attempts: [
      {
        id: 'investigation',
        stage: 'investigate',
        harness: 'codex',
        startedAt: '2026-01-01T10:00:00Z',
        finishedAt: '2026-01-01T10:01:00Z',
      },
      {
        id: 'planning',
        stage: 'plan',
        harness: 'claude',
        startedAt: '2026-01-01T10:02:00Z',
        finishedAt: '2026-01-01T10:03:00Z',
      },
      {
        id: 'debug',
        stage: 'plan',
        role: 'debug',
        harness: 'codex',
        startedAt: '2026-01-01T10:04:00Z',
      },
    ],
  };
  const event = {
    type: 'stage_started',
    stage: 'plan',
    harness: 'claude',
    at: '2026-01-01T10:02:00.004Z',
  };
  const html = activityPassoff(task, event);
  assert.match(html, /Passed off/);
  assert.match(html, /Investigation · Codex/);
  assert.match(html, /Claude/);
  assert.match(html, /<time/);
  assert.equal(activityPassoff(task, { ...event, type: 'activity' }), '');
  assert.equal(activityPassoff(task, { ...event, attemptId: 'investigation' }), '');
  assert.match(
    activityPassoff(task, { ...event, attemptId: 'debug', at: '2026-01-01T10:04:00Z' }),
    /Debugger · Codex/,
  );
  task.attempts[0].finishedAt = '2026-01-01T10:02:01Z';
  assert.equal(activityPassoff(task, event), '');
  delete task.attempts[0].finishedAt;
  assert.equal(activityPassoff(task, event), '');
});
