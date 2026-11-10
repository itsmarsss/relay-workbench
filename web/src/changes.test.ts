import test from 'node:test';
import assert from 'node:assert/strict';
import { textChanges, fieldChanges } from './changes.ts';
test('word highlights preserve both complete paragraphs', () => {
  const before = 'First paragraph.\n\nKeep this sentence with old wording.',
    after = 'First paragraph.\n\nKeep this sentence with clearer wording.';
  const parts = textChanges(before, after);
  assert.equal(
    parts
      .filter((p) => p.kind !== 'added')
      .map((p) => p.text)
      .join(''),
    before,
  );
  assert.equal(
    parts
      .filter((p) => p.kind !== 'removed')
      .map((p) => p.text)
      .join(''),
    after,
  );
  assert.deepEqual(
    parts.filter((p) => p.kind === 'removed').map((p) => p.text),
    ['old'],
  );
  assert.deepEqual(
    parts.filter((p) => p.kind === 'added').map((p) => p.text),
    ['clearer'],
  );
});
test('nested changes omit revision noise and retain removals', () => {
  assert.deepEqual(
    fieldChanges(
      { taskRevision: 'a', routing: { plan: 'codex' }, description: 'remove' },
      { taskRevision: 'b', routing: { plan: 'claude' } },
    ),
    [
      { path: 'routing.plan', before: 'codex', after: 'claude' },
      { path: 'description', before: 'remove', after: '' },
    ],
  );
});
test('long and empty text changes remain bounded and reconstructable', () => {
  for (const [before, after] of [
    ['', 'new'],
    ['old', ''],
    ['a '.repeat(2000), 'b '.repeat(2000)],
  ]) {
    const parts = textChanges(before!, after!);
    assert.equal(
      parts
        .filter((p) => p.kind !== 'added')
        .map((p) => p.text)
        .join(''),
      before,
    );
    assert.equal(
      parts
        .filter((p) => p.kind !== 'removed')
        .map((p) => p.text)
        .join(''),
      after,
    );
  }
});
