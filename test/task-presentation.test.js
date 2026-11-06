import test from 'node:test';
import assert from 'node:assert/strict';
import { issueLink, taskDetails } from '../public/task-details.js';
import {
  nativeConversations,
  retainedActivity,
  terminalSessions,
  terminalSelection,
  terminalView,
} from '../public/terminals.js';

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

test('resumed conversations use the latest attempt without hiding distinct repositories or harnesses', () => {
  const task = {
    status: 'blocked',
    repository: { id: 'api', name: 'API' },
    repositories: [
      { repository: { id: 'api', name: 'API' } },
      { repository: { id: 'client', name: 'Client' } },
    ],
    attempts: [
      {
        id: 'first',
        harness: 'codex',
        stage: 'investigate',
        sessionId: 'shared',
        repositoryId: 'api',
      },
      {
        id: 'client',
        harness: 'codex',
        stage: 'implement',
        sessionId: 'shared',
        repositoryId: 'client',
      },
      {
        id: 'review',
        harness: 'claude',
        stage: 'review',
        sessionId: 'shared',
        repositoryId: 'api',
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `retry-${i}`,
        harness: 'codex',
        stage: 'investigate',
        sessionId: 'shared',
        repositoryId: 'alias',
        workspaceRepositoryId: 'api',
      })),
      { id: 'no-session', harness: 'codex', stage: 'verify' },
    ],
  };
  const conversations = nativeConversations(task);
  assert.deepEqual(
    conversations.map((a) => [a.id, a.repositoryId, a.count]),
    [
      ['retry-9', 'api', 11],
      ['review', 'api', 1],
      ['client', 'client', 1],
    ],
  );
  const html = terminalView(task, { events: [], terminalId: '' });
  assert.equal((html.match(/data-action="resume-session"/g) ?? []).length, 3);
  assert.match(html, /data-attempt-id="retry-9" data-repository-id="api"/);
  assert.match(html, /API · 11 attempts/);
  assert.match(html, /Earlier conversations \(2\)/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(
    terminalView({ ...task, status: 'completed' }, { events: [] }),
    /resume-session/,
  );
});

test('conversation history is bounded after grouping and escapes session metadata', () => {
  const task = {
    status: 'blocked',
    repository: { id: 'api', name: '<Client>' },
    attempts: Array.from({ length: 12 }, (_, i) => ({
      id: `attempt-${i}`,
      harness: 'codex',
      stage: 'investigate',
      sessionId: `session-${i}`,
    })),
  };
  assert.equal(nativeConversations(task).length, 8);
  assert.equal(nativeConversations(task)[0].id, 'attempt-11');
  task.attempts.at(-1).sessionId = '<script>"session"</script>';
  const html = terminalView(task, { events: [] });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;Client&gt;/);
  assert.doesNotMatch(html, /<script>|<Client>/);
});

test('terminal history exposes every run with a stable number and preserves explicit selection', () => {
  const task = {
    status: 'running',
    repository: { id: 'api', name: 'API' },
    attempts: Array.from({ length: 12 }, (_, i) => ({
      id: `run-${i}`,
      harness: 'codex',
      stage: 'investigate',
      status: i === 11 ? 'running' : 'complete',
      terminal: {},
      handoff: i === 10 ? { verdict: 'blocked' } : undefined,
    })),
  };
  const sessions = terminalSessions(task);
  assert.equal(sessions.length, 12);
  assert.deepEqual(
    sessions.map((s) => s.run),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.equal(sessions.at(-2).status, 'Blocked');
  assert.equal(terminalSelection(task, '').id, 'run-11');
  assert.equal(terminalSelection(task, 'run-0').id, 'run-0');
  const html = terminalView(task, { events: [], terminalId: 'run-0' });
  assert.match(html, /value="run-0" selected/);
  assert.match(html, /Run 1 · Codex · Investigation · API · Finished/);
  assert.match(html, /Go to live run/);
  assert.doesNotMatch(html, /role="tablist"|Follow latest/);
});

test('finished run summaries separate readable activity from preserved raw output', () => {
  const events = [
    { attemptId: 'run', type: 'activity', kind: 'output', details: '{"protocol":"raw"}' },
    { attemptId: 'run', type: 'activity', kind: 'message', summary: 'Checked both callers' },
    { attemptId: 'run', type: 'activity', kind: 'message', summary: 'Checked both callers' },
    { attemptId: 'other', type: 'activity', kind: 'tool', summary: 'Unrelated check' },
    { attemptId: 'run', type: 'activity', kind: 'tool', summary: 'Starting userMessage' },
    { attemptId: 'run', type: 'activity', kind: 'tool', summary: 'Finished userMessage' },
    { attemptId: 'run', type: 'activity', kind: 'tool', summary: 'Running boundary checks' },
  ];
  assert.deepEqual(retainedActivity(events, 'run'), [
    'Checked both callers',
    'Running boundary checks',
  ]);
  const task = {
    status: 'blocked',
    workspace: '/fixture',
    repository: {},
    attempts: [
      {
        id: 'run',
        harness: 'codex',
        stage: 'investigate',
        status: 'failed',
        terminal: {},
        error: 'Check could not start <script>',
      },
    ],
  };
  const html = terminalView(task, { events });
  assert.match(html, /Check could not start &lt;script&gt;/);
  const summary = html
    .split('<div class="terminal-run-summary">')[1]
    .split('<details class="terminal-raw"')[0];
  assert.doesNotMatch(summary, /protocol|Unrelated/);
  assert.equal((summary.match(/Checked both callers/g) ?? []).length, 1);
  assert.match(html, /&quot;protocol&quot;:&quot;raw&quot;/);
  assert.match(html, /<summary>Raw output<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open|Follow latest/);
});
