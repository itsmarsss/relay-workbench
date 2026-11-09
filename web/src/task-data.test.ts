import test from 'node:test';
import assert from 'node:assert/strict';
import { eventPage, latestHandoffs, liveTerminal } from './task-data.ts';
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
