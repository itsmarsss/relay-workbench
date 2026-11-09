import test from 'node:test';
import assert from 'node:assert/strict';
import { changedFields, changePreview } from '../public/change-preview.js';
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
