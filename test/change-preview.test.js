import test from 'node:test';
import assert from 'node:assert/strict';
import { changedFields, changePreview, diffSequence } from '../public/change-preview.js';
import { taskProposalDiff } from '../public/task-proposal-view.js';

test('review diffs isolate nested changes and preserve ordered arrays and missing values', () => {
  assert.deepEqual(
    changedFields(
      { model: { effort: 'low', name: 'same' }, list: [1, 2], old: null },
      { model: { effort: 'high', name: 'same' }, list: [2, 1] },
    ),
    [
      { path: ['model', 'effort'], before: 'low', after: 'high' },
      { path: ['list'], before: [1, 2], after: [2, 1] },
      { path: ['old'], before: null, after: undefined },
    ],
  );
  assert.deepEqual(changedFields({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
});

test('review markup escapes paths and values, retains full long descriptions', () => {
  const text = '<img src=x onerror=alert(1)>\n' + 'x'.repeat(50000);
  const html = changePreview({ '<script>': '' }, { '<script>': text });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('x'.repeat(50000)));
  assert.match(html, /Current:/);
  assert.match(html, /Proposed:/);
});

test('task diffs compare only settings and never invent action results', () => {
  const html = taskProposalDiff({
    operation: 'automation',
    before: { enabled: false, scope: 'reviewed', authorizationId: 'private-receipt' },
    enabled: true,
    scope: 'reviewed',
  });
  assert.match(html, /enabled/);
  assert.ok(!html.includes('authorizationId'));
  assert.ok(!html.includes('scope'));
  assert.match(
    taskProposalDiff({ operation: 'monitor', before: { monitor: false }, enabled: true }),
    /false/,
  );
  for (const operation of ['workflow', 'checkpoint', 'publish'])
    assert.equal(taskProposalDiff({ operation }), '');
  assert.match(changePreview(false, false), /No setting values change/);
});

test('JSON keys matching object prototypes are compared as own fields', () => {
  assert.deepEqual(changedFields({}, JSON.parse('{"constructor":"custom"}')), [
    { path: ['constructor'], before: undefined, after: 'custom' },
  ]);
});

test('paragraph diffs preserve unchanged lines and highlight changed words', () => {
  const html = changePreview(
    { description: 'Opening paragraph.\n\nUse the old model.\nLast paragraph.' },
    { description: 'Opening paragraph.\n\nUse the new model.\nLast paragraph.' },
  );
  assert.match(html, /change-context/);
  assert.match(html, /<mark>old<\/mark>/);
  assert.match(html, /<mark>new<\/mark>/);
  assert.equal((html.match(/Opening paragraph/g) || []).length, 1);
  assert.match(html, /diff-line-number/);
  assert.ok(!html.includes('\\n'));
});

test('line edits reconstruct both inputs with insertions, repeated lines and trailing newlines', () => {
  for (const [before, after] of [
    ['a\nb\nc\n', 'a\nx\nc\n'],
    ['same\nsame\nend', 'same\nadded\nsame\nend'],
    ['', 'new\n'],
    ['old\n', ''],
    ['a\nb', 'b\na'],
    ['x'.repeat(1000).split('').join('\n'), 'y'.repeat(1000).split('').join('\n')],
  ]) {
    const rows = diffSequence(before.split('\n'), after.split('\n'));
    assert.equal(
      rows
        .filter((row) => row.kind !== 'added')
        .map((row) => row.text)
        .join('\n'),
      before,
    );
    assert.equal(
      rows
        .filter((row) => row.kind !== 'removed')
        .map((row) => row.text)
        .join('\n'),
      after,
    );
  }
});

test('inline text highlights escape markup even inside changed words', () => {
  const html = changePreview('Use <script>old</script>', 'Use <img onerror=bad>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;/);
});
