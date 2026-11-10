import test from 'node:test';
import assert from 'node:assert/strict';
import { activityEntries, activityWindow } from './activity-window.ts';

test('activity shows one validated handoff per attempt without losing live results', () => {
  const interim = {
    seq: 1,
    type: 'activity',
    kind: 'handoff',
    attemptId: 'a',
    details: 'Retain the full **diagnosis**.',
  };
  const otherAttempt = { ...interim, seq: 2, attemptId: 'b' };
  const handoff = { seq: 3, type: 'handoff', attemptId: 'a' };
  const transcript = { seq: 4, type: 'transcript', attemptId: 'a' };
  assert.deepEqual(activityEntries([interim]), [interim]);
  assert.deepEqual(activityEntries([interim, otherAttempt, handoff, transcript]), [
    otherAttempt,
    { ...handoff, details: interim.details },
    transcript,
  ]);
  assert.equal('details' in handoff, false, 'Presentation must not mutate stored cursor rows');
});

test('unidentified and rejected results remain available for diagnosis', () => {
  const events = [
    { seq: 1, type: 'activity', kind: 'handoff' },
    { seq: 2, type: 'handoff' },
    { seq: 3, type: 'activity', kind: 'handoff', attemptId: 'failed' },
    { seq: 4, type: 'recovery', attemptId: 'failed' },
    { seq: 5, type: 'activity', kind: 'message', attemptId: 'complete' },
    { seq: 6, type: 'handoff', attemptId: 'complete' },
  ];
  assert.deepEqual(activityEntries(events), events);
});

test('bounded activity windows keep recoverable cursors in both directions', () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({ seq: index + 201 }));
  const live = activityWindow(rows, [{ seq: 2201 }], 'later');
  assert.equal(live.first, 202);
  assert.equal(live.last, 2201);
  assert.equal(live.trimmed, true);
  const older = activityWindow(
    live.rows,
    rows.filter((row) => row.seq < live.first),
    'earlier',
  );
  assert.equal(older.first, 201);
  assert.equal(older.last, 2200);
  assert.equal(older.rows.length, 2000);
  const overlapping = activityWindow(older.rows, [{ seq: 201 }, { seq: 200 }], 'earlier');
  assert.equal(overlapping.first, 200);
  assert.equal(overlapping.last, 2199);
  assert.equal(new Set(overlapping.rows.map((row) => row.seq)).size, 2000);
});
