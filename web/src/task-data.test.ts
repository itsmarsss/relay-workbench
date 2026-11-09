import test from 'node:test';
import assert from 'node:assert/strict';
import { eventPage, latestHandoffs, latestPlan, liveTerminal } from './task-data.ts';
test('terminal selection respects manual control and live process status', () => {
  assert.deepEqual(liveTerminal({ status: 'manual', manual: { active: true, session: 'abc' } }), {
    id: 'manual',
    label: 'Your shell',
  });
  assert.equal(
    liveTerminal({ status: 'paused', attempts: [{ id: 'a', status: 'running', terminal: {} }] }),
    null,
  );
  assert.deepEqual(
    liveTerminal({
      status: 'running',
      attempts: [
        { id: 'a', status: 'complete', terminal: {} },
        { id: 'b', status: 'running', terminal: {}, stage: 'implement', harness: 'codex' },
      ],
    }),
    { id: 'b', label: 'codex · implement' },
  );
  assert.deepEqual(
    liveTerminal({
      status: 'completed',
      repositories: [{ delivery: { id: 'p', status: 'running', terminal: {} } }],
    }),
    { id: 'p', label: 'Publication' },
  );
});
test('activity cursors retain monotonic progress even for filtered log entries', () => {
  const first = eventPage(
    [
      { seq: 1, type: 'activity', text: 'x' },
      { seq: 2, type: 'transcript', text: 'y' },
    ],
    0,
    'activity',
  );
  assert.equal(first.cursor, 2);
  assert.equal(first.entries.length, 1);
  assert.deepEqual(
    eventPage([{ seq: 3, type: 'transcript', text: 'z' }], first.cursor, 'logs').entries.map(
      (e) => e.text,
    ),
    ['z'],
  );
  assert.throws(() => eventPage([{ seq: 1 }], 2, 'activity'), /cursor/);
});
test('handoffs stay bounded and plain text', () => {
  const handoffs = latestHandoffs({
    attempts: Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      stage: 'review',
      handoff: { summary: '<script>' + i },
    })),
  });
  assert.equal(handoffs.length, 20);
  assert.equal(handoffs[0]!.text, '<script>49');
});
test('plan preview selects the current completed proposal and recommendation', () => {
  const plan = {
    verdict: 'complete',
    summary: 'Proposed',
    details: 'Evidence',
    recommendedOptionId: 'a',
    recommendationReason: 'Simpler',
    options: [{ id: 'a', title: 'A', description: 'Approach', tradeoffs: 'Tradeoff' }],
  };
  const task = {
    followUpContext: { id: 'new', startedAt: '2026-01-02T00:00:00Z' },
    attempts: [
      { stage: 'plan', status: 'complete', startedAt: '2026-01-01T00:00:00Z', handoff: plan },
      { stage: 'plan', status: 'complete', role: 'debug', followUpId: 'new', handoff: plan },
      { stage: 'plan', status: 'complete', followUpId: 'new', handoff: plan },
    ],
  };
  assert.equal(latestPlan(task)?.recommendedId, 'a');
  task.attempts.pop();
  assert.equal(latestPlan(task), null);
  assert.equal(
    latestPlan({
      attempts: [{ stage: 'plan', status: 'complete', handoff: { ...plan, options: [{}] } }],
    }),
    null,
  );
});
