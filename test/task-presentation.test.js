import test from 'node:test';
import assert from 'node:assert/strict';
import { issueLink, taskDetails } from '../public/task-details.js';
import { terminalSelection, terminalView } from '../public/terminals.js';

test('source issue links reject executable URLs and escape ticket content', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://user:secret@example.com/issue',
  ])
    assert.doesNotMatch(issueLink(value), /<a /);
  assert.match(
    issueLink('https://github.com/example/service/issues/42'),
    /GitHub · example\/service#42/,
  );
  assert.doesNotMatch(issueLink('<img src=x onerror=alert(1)>'), /<img/);
  assert.match(issueLink('https://issues.example.com/42?q="test"'), /rel="noopener noreferrer"/);
  assert.match(
    taskDetails({ description: '<script>bad</script>\n\n```sql\nSELECT 1\n```' }),
    /&lt;script&gt;/,
  );
  assert.doesNotMatch(taskDetails({ description: '<script>bad</script>' }), /<script>/);
});

test('terminal empty states and session history stay available without a live workspace', () => {
  const state = { events: [], terminalId: '', terminalFollow: true };
  assert.match(terminalView({ attempts: [], repository: {} }, state), /No workspace yet/);
  assert.match(terminalView({ demo: true, attempts: [], repository: {} }, state), /simulated/);
  const task = {
    status: 'running',
    workspace: '/workspace',
    repository: {},
    attempts: [
      { id: 'old', status: 'complete', harness: 'claude', stage: 'plan', terminal: {} },
      {
        id: 'new',
        status: 'running',
        harness: 'codex',
        stage: 'implement',
        terminal: { attachCommand: 'attach' },
      },
    ],
  };
  assert.equal(terminalSelection(task, '').id, 'new');
  assert.equal(terminalSelection(task, 'old').id, 'old');
  const html = terminalView(task, {
    ...state,
    terminalPreview: { id: 'new', available: true, output: '<script>terminal text</script>' },
  });
  assert.match(html, /&lt;script&gt;terminal text&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const finished = terminalView(
    { ...task, status: 'completed' },
    {
      ...state,
      terminalId: 'old',
      events: [{ attemptId: 'old', type: 'activity', details: 'Retained message' }],
    },
  );
  assert.match(finished, /Retained message/);
  assert.doesNotMatch(finished, /Copy attach command/);
});
