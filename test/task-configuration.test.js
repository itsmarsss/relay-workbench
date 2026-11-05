import test from 'node:test';
import assert from 'node:assert/strict';
import { newTask, reconfigureTask, executionConfig, validateConfig } from '../server/domain.js';
import { filterTasks } from '../public/tasks.js';

function fixture() {
  const repositories = ['service', 'client'].map((id) => ({
    id,
    name: id,
    path: `/tmp/${id}`,
    cwd: '.',
    strategy: 'worktree',
    setup: [],
    checks: [{ command: 'node', args: ['--version'] }],
    instructions: '',
  }));
  const config = validateConfig({ repositories });
  const task = newTask(
    {
      title: 'Contract upgrade',
      repositoryId: 'client',
      repositoryIds: ['client', 'service'],
      dependencies: [{ repositoryId: 'client', dependsOn: 'service' }],
    },
    config,
  );
  return { config, task };
}

test('task settings preserve snapshots and never modify shared profiles', () => {
  const { config, task } = fixture();
  const original = structuredClone(config);
  reconfigureTask(
    task,
    {
      expectedRevision: 0,
      title: 'Refined contract',
      description: '# Requirements',
      ticket: 'https://github.com/example/service/issues/42',
      routing: { review: 'codex' },
      models: { review: 'specialist' },
      execution: { timeoutMinutes: 12, maxRepairRounds: 5 },
      smartRouting: true,
      repositorySettings: [
        {
          id: 'client',
          cwd: 'src',
          checks: [{ command: 'node', args: ['check.js'] }],
          instructions: 'Keep compatibility.',
        },
      ],
    },
    config,
  );
  assert.equal(task.configRevision, 1);
  assert.equal(task.repository.cwd, 'src');
  assert.equal(task.repositories.find((e) => e.repository.id === 'client').repository.cwd, 'src');
  assert.equal(task.smartRouting, true);
  assert.deepEqual(config, original);
  const runtime = executionConfig(task, config, 'review');
  assert.equal(runtime.harnesses.codex.model, 'specialist');
  assert.equal(runtime.timeoutMinutes, 12);
  assert.equal(runtime.maxRepairRounds, 5);
  assert.deepEqual(config, original);
  assert.notEqual(executionConfig(task, config, 'implement').harnesses.codex.model, 'specialist');
  assert.throws(
    () => reconfigureTask(task, { expectedRevision: 0, title: 'Overwrite' }, config),
    /latest settings/,
  );
  assert.equal(task.title, 'Refined contract');
});

test('task settings validate commands, unknown fields, limits and topology', () => {
  const { config, task } = fixture();
  for (const change of [
    { status: 'completed' },
    { workspace: '/tmp/other' },
    { routing: { unknown: 'codex' } },
    { routing: { implement: 'unknown' } },
    { models: { unknown: 'model' } },
    { execution: { timeoutMinutes: 0 } },
    { execution: { maxRepairRounds: 11 } },
    { repositorySettings: [{ id: 'client', path: '/tmp/other' }] },
    { repositorySettings: [{ id: 'client', checks: ['node test.js'] }] },
    { repositorySettings: [{ id: 'unknown', instructions: 'x' }] },
    {
      dependencies: [
        { repositoryId: 'client', dependsOn: 'service' },
        { repositoryId: 'service', dependsOn: 'client' },
      ],
    },
  ]) {
    const before = structuredClone(task);
    assert.throws(() => reconfigureTask(task, { expectedRevision: 0, ...change }, config));
    assert.deepEqual(task, before);
  }
});

test('started edits preserve all workspaces and require fresh approach approval', () => {
  const { config, task } = fixture();
  task.status = 'awaiting_final';
  task.stage = 'final';
  task.chosenApproach = 'shared-boundary';
  task.attempts = [{ id: 'attempt', stage: 'implement', status: 'complete' }];
  task.approvals = [{ optionId: 'shared-boundary' }];
  task.reviewedFingerprint = 'old';
  task.verifiedFingerprint = 'old';
  for (const entry of [task, ...task.repositories]) {
    entry.workspace = `/tmp/workspace-${entry.repository.id}`;
    entry.branch = 'relay/task';
    entry.baseCommit = 'base';
  }
  const workspaces = task.repositories.map((e) => [e.workspace, e.branch, e.baseCommit]);
  reconfigureTask(task, { expectedRevision: 0, description: 'New requirement' }, config);
  assert.equal(task.status, 'paused');
  assert.equal(task.stage, 'investigate');
  assert.equal(task.chosenApproach, null);
  assert.equal(task.reviewedFingerprint, null);
  assert.equal(task.verifiedFingerprint, null);
  assert.deepEqual(
    task.repositories.map((e) => [e.workspace, e.branch, e.baseCommit]),
    workspaces,
  );
  assert.equal(task.attempts.length, 1);
  assert.equal(task.approvals.length, 1);
  assert.match(task.messages.at(-1).text, /new approach approval/);
  for (const change of [
    { repositoryIds: ['client'], dependencies: [] },
    { repositorySettings: [{ id: 'client', cwd: 'elsewhere' }] },
    { repositorySettings: [{ id: 'client', setup: [{ command: 'node', args: ['setup.js'] }] }] },
    { dependencies: [] },
  ])
    assert.throws(
      () => reconfigureTask(task, { expectedRevision: 1, ...change }, config),
      /locked after starting/,
    );
});

test('verification edits rerun checks and review while retaining the approved approach', () => {
  const { config, task } = fixture();
  task.status = 'awaiting_final';
  task.stage = 'final';
  task.chosenApproach = { id: 'approved' };
  const result = reconfigureTask(
    task,
    {
      expectedRevision: 0,
      repositorySettings: [
        { id: 'client', checks: [{ command: 'node', args: ['extra-check.js'] }] },
      ],
    },
    config,
  );
  assert.equal(result.reset, true);
  assert.equal(task.stage, 'verify');
  assert.equal(task.status, 'paused');
  assert.deepEqual(task.chosenApproach, { id: 'approved' });
  for (const status of ['running', 'manual', 'completed', 'cancelled']) {
    task.status = status;
    assert.throws(
      () => reconfigureTask(task, { expectedRevision: 1, title: 'x' }, config),
      /Pause the workflow/,
    );
  }
});

test('task navigation combines scopes, repositories, stages and sorting', () => {
  const { config, task } = fixture();
  const tasks = [
    task,
    { ...newTask({ title: 'Decision', demo: true }, config), status: 'awaiting_plan' },
    { ...newTask({ title: 'Done', demo: true }, config), status: 'completed' },
  ];
  const state = {
    filter: 'all',
    repositoryFilter: '',
    stageFilter: '',
    search: '',
    taskSort: 'priority',
  };
  assert.deepEqual(
    filterTasks(tasks, state).map((t) => t.title),
    ['Decision', 'Contract upgrade', 'Done'],
  );
  assert.equal(filterTasks(tasks, { ...state, filter: 'attention' }).length, 1);
  assert.equal(
    filterTasks(tasks, {
      ...state,
      filter: 'backlog',
      repositoryFilter: 'service',
      stageFilter: 'backlog',
      search: 'contract',
    }).length,
    1,
  );
  assert.equal(
    filterTasks(tasks, { ...state, filter: 'completed', repositoryFilter: 'service' }).length,
    0,
  );
  assert.deepEqual(
    filterTasks(tasks, { ...state, taskSort: 'title' }).map((t) => t.title),
    ['Contract upgrade', 'Decision', 'Done'],
  );
  assert.equal(tasks[0].title, 'Contract upgrade');
});
