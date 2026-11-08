import { blockerDecisionView } from '../public/blocker-decision.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverBlocked, resumableAttempt, recoveryHarnesses } from '../server/recovery.js';
import { developmentAccess } from '../server/access.js';
import { validateConfig } from '../server/domain.js';
import { taskSummary, concise, activityArchiveCount } from '../public/task-summary.js';

test('recovery is bounded, repository scoped, and can be disabled', () => {
  const task = { stage: 'investigate', repositoryCursor: 0 };
  const handoff = { summary: 'Missing prerequisite' };
  assert.equal(recoverBlocked(task, handoff, 2), true);
  assert.equal(task.error, null);
  assert.equal(recoverBlocked(task, handoff, 2), true);
  assert.equal(recoverBlocked(task, handoff, 2), false);
  assert.equal(task.status, 'blocked');
  assert.equal(task.error, handoff.summary);
  task.repositoryCursor = 1;
  assert.equal(recoverBlocked(task, handoff, 2), true);
  task.stage = 'review';
  assert.equal(recoverBlocked(task, handoff, 0), false);
  assert.equal(task.recovery.attempts, 0);
  assert.equal(task.stage, 'review');
});

test('host execution supersedes legacy development access restrictions', () => {
  assert.equal(developmentAccess({}, 'investigate').writable, true);
  assert.equal(developmentAccess({}, 'implement').writable, true);
  const repository = {
    id: 'repo',
    name: 'Fixture',
    path: '/tmp/source',
    developmentAccess: {
      analysisCommands: true,
      networkAccess: true,
      writableRoots: ['/tmp/logs'],
    },
  };
  const config = validateConfig({ repositories: [repository] });
  const access = developmentAccess({ repository: config.repositories[0] }, 'investigate');
  assert.deepEqual(access, {
    elevated: true,
    writable: true,
    networkAccess: true,
    writableRoots: [],
  });
  assert.equal(developmentAccess({ repository }, 'triage').writable, true);
  for (const writableRoots of [['/'], ['relative'], ['/tmp/../'], 'all'])
    assert.throws(
      () =>
        validateConfig({ repositories: [{ ...repository, developmentAccess: { writableRoots } }] }),
      /Writable roots/,
    );
  assert.throws(() => validateConfig({ maxRecoveryAttempts: 6 }), /maxRecoveryAttempts/);
});

test('task context stays concise, escaped, and distinguishes automatic work from human decisions', () => {
  assert.ok(concise('word '.repeat(200)).length <= 240);
  const task = {
    title: '<script>bad</script>',
    stage: 'investigate',
    status: 'running',
    attempts: [],
    recovery: { active: true, reason: 'Missing <runtime>' },
  };
  let html = taskSummary(task);
  assert.match(html, /No action needed/);
  assert.match(html, /&lt;runtime&gt;/);
  assert.doesNotMatch(html, /<runtime>/);
  task.status = 'blocked';
  task.recovery = { attempts: 2, exhausted: true };
  html = taskSummary(task);
  assert.match(html, /after 2 attempts/);
  assert.match(html, /Your next step/);
  task.status = 'awaiting_plan';
  assert.match(taskSummary(task), /Choose an approach/);
});

test('resumed tasks show current context and collapse earlier attempts', () => {
  const task = {
    status: 'running',
    stage: 'investigate',
    title: 'Fixture',
    attempts: [
      { id: 'old', status: 'complete', handoff: { summary: 'Stale blocker', verdict: 'blocked' } },
      { id: 'new', stage: 'investigate', status: 'running', startedAt: '2026-01-02T00:00:00Z' },
    ],
  };
  assert.doesNotMatch(taskSummary(task), /Stale blocker/);
  assert.match(taskSummary(task), /starting with the saved task context/);
  const events = [
    { attemptId: 'old', type: 'handoff' },
    { type: 'stage_started', stage: 'investigate', at: '2026-01-02T00:00:00Z' },
    { attemptId: 'new', type: 'activity' },
  ];
  assert.equal(activityArchiveCount(task, events), 1);
  events[2].summary = 'Checking the actual task source';
  events[2].kind = 'message';
  assert.match(taskSummary(task, events), /Checking the actual task source/);
  task.status = 'completed';
  assert.equal(activityArchiveCount(task, events), 0);
});

test('recovery starts fresh, carries evidence, and uses only enabled alternatives', () => {
  const task = {
    stage: 'investigate',
    attempts: [
      {
        stage: 'investigate',
        harness: 'codex',
        repositoryId: null,
        status: 'complete',
        sessionId: 'blocked-native',
        handoff: {
          verdict: 'blocked',
          summary: 'Host killed test',
          details: 'Killed before output',
          evidence: ['exit signal 9'],
          risks: ['Cause unproven'],
        },
      },
    ],
  };
  assert.equal(resumableAttempt(task, 'investigate', 'codex', null), undefined);
  const harnesses = { codex: { enabled: true }, claude: { enabled: false }, pi: { enabled: true } };
  recoverBlocked(task, task.attempts[0].handoff);
  assert.equal(resumableAttempt(task, 'investigate', 'codex', null), undefined);
  assert.deepEqual(task.recovery.evidence[0].evidence, ['exit signal 9']);
  assert.deepEqual(recoveryHarnesses(task, 'codex', harnesses), ['codex']);
  recoverBlocked(task, task.attempts[0].handoff);
  assert.deepEqual(recoveryHarnesses(task, 'codex', harnesses), ['pi', 'codex']);
  task.recovery = null;
  task.attempts.push({
    stage: 'investigate',
    harness: 'codex',
    repositoryId: null,
    status: 'interrupted',
    sessionId: 'interrupted-native',
  });
  assert.equal(
    resumableAttempt(task, 'investigate', 'codex', null).sessionId,
    'interrupted-native',
  );
  task.attempts.push({
    stage: 'investigate',
    harness: 'codex',
    repositoryId: null,
    status: 'complete',
    sessionId: 'finished-native',
    handoff: { verdict: 'complete' },
  });
  assert.equal(resumableAttempt(task, 'investigate', 'codex', null), undefined);
});

test('blocker decisions expose safe choices and escape imported evidence', () => {
  const html = blockerDecisionView({
    status: 'blocked',
    blockerDecision: {
      id: 'decision',
      summary: '<script>unsafe</script>',
      explanation: 'A diagnostic failed',
      required: ['Runtime access is needed'],
      evidence: ['Attempted isolated reproduction'],
      debugAttempts: 2,
      options: [
        {
          id: 'runtime',
          title: 'Choose runtime',
          description: 'Use a supported test host',
          tradeoffs: 'Keeps scope unchanged',
        },
      ],
    },
  });
  assert.match(html, /YOUR DECISION/);
  assert.match(html, /What needs your input/);
  assert.match(html, /Revise approach/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(blockerDecisionView({ status: 'running' }), '');
});

test('genuine design choices escalate without spending another retry', () => {
  const task = {
    stage: 'implement',
    attempts: [{ id: 'diagnosis', role: 'debug', stage: 'implement' }],
  };
  const handoff = {
    summary: 'A product decision is required',
    evidence: ['Both approaches pass'],
    risks: ['Choose compatibility or simplicity'],
    options: [
      {
        id: 'design-compatible',
        title: 'Preserve compatibility',
        description: 'Keep the existing contract',
        tradeoffs: 'More implementation complexity',
      },
    ],
  };
  assert.equal(recoverBlocked(task, handoff), false);
  assert.equal(task.recovery.attempts, 0);
  assert.equal(task.blockerDecision.id, 'diagnosis');
  assert.deepEqual(task.blockerDecision.options, handoff.options);
  assert.match(blockerDecisionView(task), /Plan this direction/);
  assert.equal(recoverBlocked(task, handoff, 2, true), true);
});

test('host execution applies independently of diagnostic context', () => {
  const task = { debugContext: { executionAccess: 'host' } };
  assert.equal(developmentAccess(task, 'investigate').elevated, true);
  for (const stage of ['triage', 'plan', 'implement', 'review'])
    assert.equal(developmentAccess(task, stage).elevated, true);
  assert.equal(
    developmentAccess({ description: 'executionAccess: host' }, 'investigate').elevated,
    true,
  );
});
