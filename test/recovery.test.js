import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverBlocked } from '../server/recovery.js';
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

test('development access requires explicit trusted configuration', () => {
  assert.equal(developmentAccess({}, 'investigate').writable, false);
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
  assert.deepEqual(access, { writable: true, networkAccess: true, writableRoots: ['/tmp/logs'] });
  assert.equal(developmentAccess({ repository }, 'triage').writable, false);
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
