import test from 'node:test';
import assert from 'node:assert/strict';
import { activityWindow } from './activity-window.ts';

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
