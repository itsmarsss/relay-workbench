import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentBlocker,
  diffPreviewLines,
  eventPage,
  externalURL,
  latestHandoffs,
  latestPlan,
  liveTerminal,
  optionLead,
  parseDiff,
  tradeoffPoints,
} from './task-data.ts';
test('external result links permit only credential-free web URLs', () => {
  assert.equal(externalURL('https://example.com/pull/1'), 'https://example.com/pull/1');
  for (const value of [
    'javascript:alert(1)',
    'file:///tmp/file',
    'https://user:secret@example.com',
    'bad',
    null,
  ]) {
    assert.equal(externalURL(value), null);
  }
});
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
      {
        id: 'old',
        stage: 'plan',
        status: 'complete',
        startedAt: '2026-01-01T00:00:00Z',
        handoff: plan,
      },
      {
        id: 'debug',
        stage: 'plan',
        status: 'complete',
        role: 'debug',
        followUpId: 'new',
        handoff: plan,
      },
      { id: 'new', stage: 'plan', status: 'complete', followUpId: 'new', handoff: plan },
    ],
  };
  assert.equal(latestPlan(task)?.recommendedId, 'a');
  assert.equal(latestPlan(task)?.attemptId, 'new');
  const longId = '界'.repeat(100);
  const longPlan = {
    ...plan,
    recommendedOptionId: longId,
    options: [{ ...plan.options[0]!, id: longId }],
  };
  assert.equal(
    latestPlan({ attempts: [{ id: 'p', stage: 'plan', status: 'complete', handoff: longPlan }] })
      ?.recommendedId,
    longId,
  );
  task.attempts.pop();
  assert.equal(latestPlan(task), null);
  assert.equal(
    latestPlan({
      attempts: [{ stage: 'plan', status: 'complete', handoff: { ...plan, options: [{}] } }],
    }),
    null,
  );
});
test('change previews retain additions, deletions, files and explicit limits', () => {
  const repos = parseDiff({
    repositories: [
      {
        repositoryId: 'a',
        name: 'Repo',
        diff: {
          text: '--- a/file\n+++ b/file\n-old\n+new\n',
          stat: '1 file changed',
          untracked: [{ name: 'new.txt', content: '<safe>' }],
          untrackedOmitted: 2,
        },
      },
    ],
  });
  assert.equal(repos[0]!.untracked[0]!.content, '<safe>');
  assert.equal(repos[0]!.omittedCount, 2);
  const preview = diffPreviewLines(repos[0]!.text);
  assert.deepEqual(
    preview.lines.map((line) => line.kind),
    ['', '', 'deletion', 'addition'],
  );
  assert.equal(diffPreviewLines('a\nb\nc\n', 2).truncated, true);
  assert.throws(
    () => parseDiff({ repositories: [{ repositoryId: 'a', name: 'Repo', diff: { text: 1 } }] }),
    /Invalid changes/,
  );
});
test('blocker details are shown only for an unresolved current decision', () => {
  const blocker = {
    id: 'd',
    summary: 'Needs input',
    explanation: 'Details',
    evidence: ['Evidence'],
    required: ['Direction'],
    options: [{ id: 'a', title: 'Option', description: 'Approach', tradeoffs: 'Cost' }],
  };
  assert.equal(
    currentBlocker({ status: 'blocked', blockerDecision: blocker })?.options[0]?.id,
    'a',
  );
  assert.equal(
    currentBlocker({ status: 'blocked', blockerDecision: { ...blocker, resolved: true } }),
    null,
  );
  assert.equal(currentBlocker({ status: 'running', blockerDecision: blocker }), null);
});
test('an option splits into the idea and the steps that follow it', () => {
  assert.deepEqual(
    optionLead('Retry once on a fresh connection.\n- Add a predicate\n- Add a loop'),
    {
      lead: 'Retry once on a fresh connection.',
      rest: '- Add a predicate\n- Add a loop',
    },
  );
  assert.deepEqual(optionLead('First line\nsame paragraph.\n\nSecond paragraph.\n\n1. Step'), {
    lead: 'First line\nsame paragraph.',
    rest: 'Second paragraph.\n\n1. Step',
  });
  assert.deepEqual(optionLead('Only one paragraph, with a - dash and 2.5 in it.'), {
    lead: 'Only one paragraph, with a - dash and 2.5 in it.',
    rest: '',
  });
  assert.deepEqual(optionLead('- Step one\n- Step two'), {
    lead: '',
    rest: '- Step one\n- Step two',
  });
  assert.deepEqual(optionLead('Idea.\n```sh\nmake\n```'), {
    lead: 'Idea.',
    rest: '```sh\nmake\n```',
  });
});
test('tradeoffs are read as points only when every line is a pro or a con', () => {
  assert.deepEqual(
    tradeoffPoints('- Pro: one rule in the parser\n- Con: two stages,\n  with a release between\n'),
    [
      { kind: 'pro', text: 'one rule in the parser' },
      { kind: 'con', text: 'two stages, with a release between' },
    ],
  );
  assert.deepEqual(tradeoffPoints('**Pros:** small diff\nCons: no rollback'), [
    { kind: 'pro', text: 'small diff' },
    { kind: 'con', text: 'no rollback' },
  ]);
  assert.equal(tradeoffPoints('- Smallest change\n- Can return a newer snapshot'), null);
  assert.equal(tradeoffPoints('- Pro: small\n- Needs a release'), null);
  assert.equal(tradeoffPoints('Small diff. Con: two mechanisms remain.'), null);
  assert.equal(tradeoffPoints(''), null);
});
