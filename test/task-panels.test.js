import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffBody, handoffList, workflowStages, executionLogs } from '../public/task-panels.js';
import { diffLines, diffFileGroups } from '../public/diff-lines.js';

test('handoffs preserve full risks, filenames, and evidence behind clear sections', () => {
  const report = {
    summary: 'Outcome',
    risks: ['one', 'two', '<script>third</script>'],
    files: ['repo/src/a.js'],
    details: 'The full explanation',
    evidence: ['Exit 0'],
    findings: [],
  };
  const html = handoffBody(report);
  assert.match(html, /Full risks &amp; limitations/);
  assert.match(html, /&lt;script&gt;third/);
  assert.match(html, /<strong>a.js<\/strong>/);
  assert.match(html, /Verification & evidence/);
  assert.doesNotMatch(html, /<script>/);
  const list = handoffList({
    attempts: [
      { id: 'first', stage: 'plan', harness: 'claude', handoff: report },
      { id: 'second', stage: 'implement', harness: 'codex', handoff: report },
    ],
  });
  assert.ok(list.indexOf('handoff-second') < list.indexOf('handoff-first'));
});

test('workflow nests host verification without duplicating active timers', () => {
  const task = {
    status: 'running',
    stage: 'implement',
    routing: { implement: 'codex' },
    attempts: [
      {
        id: 'code',
        stage: 'implement',
        status: 'complete',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:01:00Z',
      },
      {
        id: 'host',
        stage: 'implement',
        role: 'verifier',
        status: 'running',
        startedAt: '2026-01-01T00:02:00Z',
      },
    ],
  };
  const html = workflowStages(task);
  assert.match(html, /workflow-subrun/);
  assert.match(html, /Configured checks/);
  const agentTask = structuredClone(task);
  agentTask.attempts.at(-1).harness = 'codex';
  agentTask.attempts.at(-1).executionAccess = 'host';
  assert.match(workflowStages(agentTask), /Verification agent/);
  assert.equal((html.match(/data-live-start=/g) ?? []).length, 1);
});

test('execution output filters by run, stream and literal text and escapes output', () => {
  const task = { attempts: [{ id: 'a' }, { id: 'b' }] };
  const events = [
    { type: 'transcript', attemptId: 'a', stream: 'stderr', text: 'old failure' },
    { type: 'transcript', attemptId: 'b', stream: 'stderr', text: '<script>failure</script>' },
    { type: 'transcript', attemptId: 'b', stream: 'stdout', text: 'other output' },
  ];
  const html = executionLogs(task, events, { stream: 'stderr', query: 'FAILURE' });
  assert.match(html, /&lt;script&gt;failure/);
  assert.doesNotMatch(html, /old failure|other output|<script>/);
  assert.match(executionLogs(task, events, { query: 'absent' }), /No output matches/);
});

test('file grouping preserves original diff indices for review anchors', () => {
  const diff = {
    text: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new',
    untracked: [{ name: 'new.js', content: 'added' }],
  };
  const original = diffLines(diff);
  const files = diffFileGroups(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'a.js');
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
  for (const group of files)
    for (const line of group.lines) assert.deepEqual(line.anchor, original[line.index].anchor);
});

test('handoffs show actual delivery outcomes without requiring an agent verdict', () => {
  for (const [status, label] of [
    ['complete', 'Complete'],
    ['failed', 'Failed'],
    ['running', 'Running'],
    ['interrupted', 'Paused'],
  ]) {
    const html = handoffList({
      attempts: [],
      deliveryRuns: [
        { id: 'delivery', stage: 'publish', status, handoff: { summary: 'Publication outcome' } },
      ],
    });
    assert.match(html, new RegExp('class="verdict [^"]+">' + label + '</span>'));
  }
  const delegated = handoffList({
    attempts: [
      {
        id: 'repair',
        status: 'complete',
        stage: 'implement',
        handoff: { verdict: 'repair_requested', summary: 'Delegate repair' },
      },
    ],
  });
  assert.match(delegated, /Repair delegated/);
  const blocked = handoffList({
    attempts: [
      {
        id: 'blocked',
        status: 'complete',
        stage: 'implement',
        handoff: { verdict: 'blocked', summary: 'Needs a choice' },
      },
    ],
  });
  assert.match(blocked, /class="verdict fail">Blocked/);
});
