import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { DEFAULT_CONFIG, newTask, validateHandoff } from '../server/domain.js';
import { git, fingerprint, prepareWorkspace } from '../server/workspace.js';
import {
  captureCheckpoint,
  checkpoints,
  forkCheckpoint,
  workflowHistory,
} from '../server/workflow-checkpoints.js';
import { WorkflowAutomation, automationState } from '../server/workflow-automation.js';
import { workflowHealth } from '../server/workflow-health.js';
import { demoHandoff, buildPrompt } from '../server/harness.js';
import { inbox } from '../server/inbox.js';
import { blockerDecision } from '../server/recovery.js';
import { applyLoopGuard } from '../server/loop-guard.js';
import { executionNodes, graphLayout } from '../public/execution-map.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-controls-'));
  const store = new Store(join(root, 'state'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Workflow did not reach expected state');
}

test('Auto follows a structured recommendation and completes a reviewed demo', async (t) => {
  const { store } = await fixture(t);
  const engine = new Engine(store, { demoDelay: 1 });
  const auto = new WorkflowAutomation(store, engine, {}, { interval: 60000 });
  t.after(async () => {
    await auto.stop();
    await engine.stop();
  });
  const task = engine.create({ title: 'Auto demonstration', demo: true });
  assert.equal(automationState(store, task.id).enabled, false);
  await engine.action(task.id, 'start');
  await until(() => store.get(task.id).status === 'awaiting_plan' && !engine.running.has(task.id));
  await auto.tick();
  assert.equal(store.get(task.id).status, 'awaiting_plan');
  auto.configure(task.id, { enabled: true, scope: 'reviewed' });
  await auto.tick();
  await until(() => store.get(task.id).status === 'awaiting_final' && !engine.running.has(task.id));
  assert.equal(store.get(task.id).chosenApproach.id, 'shared-boundary');
  await auto.tick();
  assert.equal(store.get(task.id).status, 'completed');
  assert.equal(workflowHistory(store, task.id).decisions.length, 2);
  assert.ok(checkpoints(store, task.id).length >= 5);
  const graph = executionNodes({ ...store.get(task.id), history: workflowHistory(store, task.id) });
  assert.ok(graph.some((node) => node.stage === 'auto'));
  assert.ok(graph.some((node) => node.stage === 'checkpoint'));
});

test('Auto refuses ambiguous plans, pending direction and review findings', async (t) => {
  const { store } = await fixture(t);
  let actions = 0;
  const engine = {
    running: new Map(),
    manualRuns: new Map(),
    actionLocks: new Set(),
    action: async () => {
      actions++;
      throw new Error('Pending direction requires a new plan');
    },
  };
  const auto = new WorkflowAutomation(store, engine, {}, { interval: 60000 });
  t.after(() => auto.stop());
  const task = newTask({ title: 'Manual choice', demo: true }, DEFAULT_CONFIG);
  task.status = 'awaiting_plan';
  const handoff = demoHandoff(task, 'plan');
  delete handoff.recommendedOptionId;
  task.attempts = [{ id: 'plan', stage: 'plan', status: 'complete', handoff }];
  store.save(task);
  auto.configure(task.id, { enabled: true });
  await auto.tick();
  assert.equal(actions, 0);
  assert.match(automationState(store, task.id).error, /structured planner/);
  task.attempts[0].handoff.recommendedOptionId = 'shared-boundary';
  store.save(task);
  auto.configure(task.id, { enabled: true });
  await auto.tick();
  assert.equal(actions, 1);
  assert.match(automationState(store, task.id).error, /Pending direction/);
  task.status = 'awaiting_final';
  const review = demoHandoff(task, 'review');
  review.findings = [{ severity: 'major', file: 'a', description: 'Bug' }];
  task.attempts.push({ id: 'review', stage: 'review', status: 'complete', handoff: review });
  store.save(task);
  auto.configure(task.id, { enabled: true });
  await auto.tick();
  assert.equal(actions, 1);
  assert.match(automationState(store, task.id).error, /clean independent review/);
  assert.equal(inbox(store)[0].action, 'Review Auto decision');
});

test('Auto runtime continuation is bounded across delegation toggles', async (t) => {
  const { store } = await fixture(t);
  let actions = 0;
  const engine = {
    running: new Map(),
    manualRuns: new Map(),
    actionLocks: new Set(),
    action: async () => {
      actions++;
    },
  };
  const auto = new WorkflowAutomation(store, engine, {}, { interval: 60000 });
  t.after(() => auto.stop());
  const task = newTask({ title: 'Budget', demo: true }, DEFAULT_CONFIG);
  task.status = 'blocked';
  task.blockerDecision = { kind: 'runtime_budget' };
  store.save(task);
  auto.configure(task.id, { enabled: true });
  await auto.tick();
  auto.configure(task.id, { enabled: false });
  auto.configure(task.id, { enabled: true });
  await auto.tick();
  assert.equal(actions, 1);
  task.status = 'paused';
  store.save(task);
  await auto.tick();
  assert.equal(actions, 1);
});

test('health excludes stale attempts, heartbeats and repeated check polls', async (t) => {
  const { store } = await fixture(t);
  const start = Date.now() - 11 * 60000;
  const task = newTask({ title: 'Quiet work', demo: true }, DEFAULT_CONFIG);
  task.status = 'running';
  task.attempts = [
    {
      id: 'current',
      status: 'running',
      stage: 'implement',
      startedAt: new Date(start).toISOString(),
    },
  ];
  const event = {
    type: 'activity',
    attemptId: 'current',
    at: new Date(start + 1000).toISOString(),
    kind: 'tool',
    summary: 'Running focused tests',
  };
  const events = [
    event,
    { ...event, at: new Date().toISOString() },
    {
      ...event,
      type: 'heartbeat',
      summary: 'Check progress: running 1',
      at: new Date().toISOString(),
    },
    { ...event, attemptId: 'old', summary: 'Old output', at: new Date().toISOString() },
  ];
  assert.equal(workflowHealth(task, events).quiet, true);
  assert.equal(workflowHealth(task, events).operation, 'Running focused tests');
  store.save(task);
  for (const event of events) store.event(task.id, event);
  assert.equal(inbox(store)[0].action, 'Inspect quiet agent');
  store.event(task.id, { ...event, summary: 'Tests finished', at: new Date().toISOString() });
  assert.equal(inbox(store).length, 0);
  assert.equal(
    workflowHealth(task, [
      ...events,
      { ...event, summary: 'Check progress: compiled next package', at: new Date().toISOString() },
    ]).quiet,
    false,
  );
  task.attempts[0].verificationEvidence = [{ status: 'waiting' }];
  assert.equal(workflowHealth(task, [event], start + 2000).state, 'waiting_resource');
});

test('checkpoint forks preserve HEAD, staging and untracked files without touching source', async (t) => {
  const { root, store } = await fixture(t);
  const repo = join(root, 'repo');
  await git(root, ['init', repo]);
  await writeFile(join(repo, 'tracked'), 'base\n');
  await writeFile(join(repo, '.gitignore'), 'ignored\n');
  await git(repo, ['add', '.']);
  await git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'test: fixture',
  ]);
  const profile = {
    id: 'repo',
    name: 'Fixture',
    path: repo,
    cwd: '.',
    strategy: 'worktree',
    checks: [],
    setup: [],
    instructions: '',
    verificationMode: 'agent',
  };
  const config = { ...structuredClone(DEFAULT_CONFIG), repositories: [profile] };
  const task = newTask({ title: 'Saved work', repositoryId: 'repo' }, config);
  await prepareWorkspace(task, store.directory, []);
  const workspace = task.workspaceRoot;
  const originalBase = task.baseCommit;
  await writeFile(join(workspace, 'committed'), 'preserve this commit\n');
  await git(workspace, ['add', 'committed']);
  await git(workspace, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'test: checkpoint history',
  ]);
  task.messages = [
    { role: 'user', text: 'Preserve the compatibility contract.', delivery: 'included' },
  ];
  await writeFile(join(workspace, 'tracked'), 'staged\n');
  await git(workspace, ['add', 'tracked']);
  await writeFile(join(workspace, 'tracked'), 'unstaged\n');
  await writeFile(join(workspace, 'new-file'), 'untracked\n');
  await writeFile(join(workspace, 'ignored'), 'environment\n');
  const handoff = demoHandoff(task, 'implement');
  const attempt = {
    id: 'implemented',
    stage: 'implement',
    harness: 'codex',
    status: 'complete',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    sessionId: 'must-not-reuse',
    handoff,
  };
  task.attempts = [attempt];
  task.stage = 'verify';
  task.status = 'queued';
  task.chosenApproach = { id: 'chosen', title: 'Chosen' };
  store.save(task);
  const before = await fingerprint(task);
  const record = await captureCheckpoint(store, task, attempt);
  const staged = await git(workspace, ['diff', '--cached']);
  await writeFile(join(workspace, 'tracked'), 'newer work\n');
  const current = await fingerprint(task);
  const fork = await forkCheckpoint(store, task.id, record.id);
  assert.equal(await fingerprint(task), current);
  assert.equal(await fingerprint(fork), before);
  assert.equal(await git(fork.workspaceRoot, ['diff', '--cached']), staged);
  assert.equal(await readFile(join(fork.workspaceRoot, 'new-file'), 'utf8'), 'untracked\n');
  await assert.rejects(readFile(join(fork.workspaceRoot, 'ignored')), { code: 'ENOENT' });
  assert.notEqual(fork.workspaceRoot, workspace);
  assert.equal(fork.baseCommit, originalBase);
  assert.equal(
    await readFile(join(fork.workspaceRoot, 'committed'), 'utf8'),
    'preserve this commit\n',
  );
  assert.ok(
    fork.messages.some((message) => message.text === 'Preserve the compatibility contract.'),
  );
  assert.equal(fork.verifiedFingerprint, null);
  assert.equal(fork.reviewedFingerprint, null);
  assert.equal(fork.attempts[0].sessionId, undefined);
  assert.equal(fork.attempts[0].originTaskId, task.id);
  assert.equal(fork.status, 'paused');
  assert.equal(automationState(store, fork.id).enabled, false);
  const graphTask = { ...task, history: workflowHistory(store, task.id) };
  const layout = graphLayout(graphTask);
  const child = layout.nodes.find((n) => n.targetTaskId === fork.id);
  const parent = layout.nodes.find((n) => n.number === child.parentNumber);
  assert.equal(parent.checkpointId, record.id);
  assert.ok(layout.edges.some((e) => e.from === parent.number && e.to === child.number));
  const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(`checkpoints:${task.id}`);
  const damaged = JSON.parse(row.value);
  damaged[0].repositories[0].workingTree = '0'.repeat(40);
  store.db
    .prepare('UPDATE meta SET value=? WHERE key=?')
    .run(JSON.stringify(damaged), `checkpoints:${task.id}`);
  await assert.rejects(forkCheckpoint(store, task.id, record.id), /read-tree failed/);
  const failed = store
    .all()
    .find((item) => item.fork?.sourceTaskId === task.id && item.id !== fork.id);
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.checkpointRestore.status, 'failed');
  assert.ok(failed.workspaceRoot, 'Partially restored worktrees must retain ownership metadata');
  assert.ok(workflowHistory(store, task.id).forks.some((item) => item.taskId === failed.id));
  assert.equal(
    executionNodes({ ...task, history: workflowHistory(store, task.id) }).find(
      (item) => item.targetTaskId === failed.id,
    ).status,
    'failed',
  );
  assert.equal(await fingerprint(task), current);
  const engine = new Engine(store);
  await assert.rejects(engine.action(failed.id, 'resume'), /Finish restoring/);
  const reviewed = store.get(task.id);
  reviewed.status = 'awaiting_final';
  reviewed.reviewedFingerprint = await fingerprint(reviewed);
  store.save(reviewed);
  const auto = new WorkflowAutomation(store, engine, {}, { interval: 60000 });
  const grant = auto.configure(reviewed.id, { enabled: true });
  const accepting = engine.action(reviewed.id, 'accept', { automation: grant });
  auto.configure(reviewed.id, { enabled: false });
  await assert.rejects(accepting, /delegation changed/);
  assert.equal(store.get(reviewed.id).status, 'awaiting_final');
  await auto.stop();
  await engine.stop();
});

test('invalid plan recommendation is rejected rather than guessed', () => {
  const handoff = demoHandoff({ routing: DEFAULT_CONFIG.routing }, 'plan');
  handoff.recommendedOptionId = 'invented';
  assert.throws(() => validateHandoff(handoff, 'plan'), /proposed option/);
});

test('Auto publishing requires explicit draft scope and never repeats uncertain publication', async (t) => {
  const { store } = await fixture(t);
  let starts = 0;
  const engine = { running: new Map(), manualRuns: new Map(), actionLocks: new Set() };
  const auto = new WorkflowAutomation(
    store,
    engine,
    {
      start: async () => {
        starts++;
      },
    },
    { interval: 60000 },
  );
  t.after(() => auto.stop());
  const task = newTask({ title: 'Publish scope', demo: true }, DEFAULT_CONFIG);
  task.demo = false;
  task.status = 'completed';
  store.save(task);
  auto.configure(task.id, { enabled: true, scope: 'reviewed' });
  await auto.tick();
  assert.equal(starts, 0);
  auto.configure(task.id, { enabled: true, scope: 'draft_pr' });
  await auto.tick();
  await auto.tick();
  assert.equal(starts, 1);
});

test('multi-repository checkpoints restore the whole workspace together', async (t) => {
  const { root, store } = await fixture(t);
  const repositories = [];
  for (const name of ['service', 'client']) {
    const path = join(root, name);
    await git(root, ['init', path]);
    await writeFile(join(path, 'code'), `${name} base\n`);
    await git(path, ['add', '.']);
    await git(path, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'test: fixture',
    ]);
    repositories.push({
      id: name,
      name,
      path,
      cwd: '.',
      strategy: 'attach',
      checks: [],
      setup: [],
      instructions: '',
      verificationMode: 'agent',
    });
  }
  const task = newTask(
    { title: 'Cross-repo edits', repositoryIds: ['service', 'client'] },
    { ...DEFAULT_CONFIG, repositories },
  );
  // Use already assigned isolated source workspaces to exercise attached-profile fork conversion.
  for (const entry of task.repositories) {
    entry.workspace = entry.workspaceRoot = entry.repository.path;
    entry.baseCommit = await git(entry.workspaceRoot, ['rev-parse', 'HEAD']);
    await writeFile(join(entry.workspaceRoot, 'code'), `${entry.repository.id} changed\n`);
  }
  Object.assign(task, {
    workspace: task.repositories[0].workspace,
    workspaceRoot: task.repositories[0].workspaceRoot,
    baseCommit: task.repositories[0].baseCommit,
  });
  const attempt = {
    id: 'cross-repo',
    stage: 'implement',
    status: 'complete',
    handoff: demoHandoff(task, 'implement'),
  };
  task.attempts = [attempt];
  task.stage = 'verify';
  task.status = 'queued';
  store.save(task);
  const record = await captureCheckpoint(store, task, attempt);
  const fork = await forkCheckpoint(store, task.id, record.id);
  assert.equal(await fingerprint(fork), record.fingerprint);
  assert.ok(fork.repositories.every((entry) => entry.repository.strategy === 'worktree'));
  assert.ok(
    fork.repositories.every(
      (entry) => !repositories.some((profile) => profile.path === entry.workspaceRoot),
    ),
  );
  for (const entry of task.repositories)
    assert.equal(
      await readFile(join(entry.workspaceRoot, 'code'), 'utf8'),
      `${entry.repository.id} changed\n`,
    );
});

test('saved plan and debugger choices branch without replaying investigation', async (t) => {
  const { store } = await fixture(t);
  const engine = new Engine(store, { demoDelay: 1 });
  t.after(() => engine.stop());
  const source = newTask({ title: 'Choose a different path', demo: true }, DEFAULT_CONFIG);
  const plan = demoHandoff(source, 'plan');
  source.chosenApproach = plan.options[0];
  source.approvals = [{ type: 'approach', option: plan.options[0] }];
  const diagnosis = {
    ...demoHandoff(source, 'investigate'),
    verdict: 'blocked',
    summary: 'Two supported remedies',
    options: [
      {
        id: 'design-alternative',
        title: 'Use an alternate remedy',
        description: 'Try the other supported configuration.',
        tradeoffs: 'Requires targeted revalidation.',
      },
    ],
  };
  const at = new Date().toISOString();
  source.attempts = [
    {
      id: 'investigation',
      stage: 'investigate',
      status: 'complete',
      handoff: demoHandoff(source, 'investigate'),
      startedAt: at,
    },
    { id: 'plan', stage: 'plan', status: 'complete', handoff: plan, startedAt: at },
    {
      id: 'implementation',
      stage: 'implement',
      role: 'specialist',
      status: 'complete',
      handoff: { ...diagnosis, options: [] },
      startedAt: at,
    },
    {
      id: 'debug',
      stage: 'implement',
      role: 'debug',
      status: 'complete',
      handoff: diagnosis,
      startedAt: at,
    },
  ];
  source.stage = 'implement';
  source.status = 'blocked';
  source.recovery = {
    key: 'implement:0',
    sourceAttemptId: 'implementation',
    active: false,
    phase: 'debug',
    lastDiagnosis: diagnosis,
  };
  source.blockerDecision = blockerDecision(source, diagnosis);
  store.save(source);
  const saved = await captureCheckpoint(store, source, source.attempts.at(-1));
  assert.equal(checkpoints(store, source.id)[0].canChooseDebug, true);
  const alternate = await forkCheckpoint(store, source.id, saved.id, { stage: 'approach' });
  assert.equal(alternate.status, 'awaiting_plan');
  assert.equal(alternate.chosenApproach, null);
  assert.equal(alternate.loopGuardAcknowledgedAt, alternate.attempts.length);
  await engine.action(alternate.id, 'approve-plan', { optionId: 'patch-callers' });
  await until(
    () => store.get(alternate.id).status === 'awaiting_final' && !engine.running.has(alternate.id),
  );
  const implementation = store.get(alternate.id);
  assert.equal(implementation.chosenApproach.id, 'patch-callers');
  assert.equal(implementation.attempts.find((a) => !a.inherited).stage, 'implement');
  assert.ok(
    !implementation.attempts.some((a) => !a.inherited && ['investigate', 'plan'].includes(a.stage)),
  );
  const debugFork = await forkCheckpoint(store, source.id, saved.id, { stage: 'decision' });
  assert.equal(debugFork.status, 'blocked');
  assert.equal(debugFork.blockerDecision.options[0].id, 'design-alternative');
  const loopFixture = structuredClone(debugFork);
  for (const prior of loopFixture.attempts) prior.fingerprint = 'same-source';
  const firstFailure = {
    id: 'first-new-failure',
    stage: 'implement',
    fingerprint: 'same-source',
    handoff: diagnosis,
  };
  loopFixture.attempts.push(firstFailure);
  assert.equal(applyLoopGuard(loopFixture, firstFailure), false);
  assert.notEqual(debugFork.blockerDecision.id, source.blockerDecision.id);
  await engine.action(debugFork.id, 'resolve-blocker', {
    decisionId: debugFork.blockerDecision.id,
    resolution: 'retry',
    optionId: 'design-alternative',
  });
  await until(
    () => store.get(debugFork.id).status === 'awaiting_final' && !engine.running.has(debugFork.id),
  );
  const continued = store.get(debugFork.id);
  assert.equal(continued.attempts.find((a) => !a.inherited).role, 'debug');
  assert.ok(continued.messages.some((m) => m.text.includes('alternate remedy')));
  assert.ok(
    !continued.attempts.some((a) => !a.inherited && ['investigate', 'plan'].includes(a.stage)),
  );
  assert.equal(store.get(source.id).chosenApproach.id, 'shared-boundary');
  assert.equal(store.get(source.id).status, 'blocked');
});

test('explicit replanning survives completed snapshots and interrupted restores cannot run', async (t) => {
  const { store } = await fixture(t);
  const source = newTask({ title: 'Completed snapshot', demo: true }, DEFAULT_CONFIG);
  const handoff = demoHandoff(source, 'plan');
  source.attempts = [{ id: 'completed-plan', stage: 'plan', status: 'complete', handoff }];
  source.status = 'completed';
  source.stage = 'review';
  source.chosenApproach = handoff.options[0];
  store.save(source);
  const record = await captureCheckpoint(store, source, source.attempts[0]);
  const fork = await forkCheckpoint(store, source.id, record.id, { stage: 'plan' });
  assert.equal(fork.stage, 'plan');
  assert.equal(fork.chosenApproach, null);
  fork.checkpointRestore.status = 'preparing';
  store.save(fork);
  assert.equal(workflowHistory(store, source.id).forks[0].status, 'preparing');
  store.db.prepare('DELETE FROM meta WHERE key=?').run(`forks:${source.id}`);
  assert.equal(workflowHistory(store, source.id).forks[0].status, 'preparing');
  const engine = new Engine(store);
  assert.equal(store.get(fork.id).checkpointRestore.status, 'failed');
  assert.equal(store.get(fork.id).status, 'blocked');
  const recovered = workflowHistory(store, source.id).forks;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].taskId, fork.id);
  assert.equal(recovered[0].status, 'failed');
  for (const action of ['resume', 'debug', 'verify-blocker', 'resolve-blocker', 'takeover'])
    await assert.rejects(engine.action(fork.id, action), /Finish restoring/);
  await engine.action(fork.id, 'cancel');
  assert.equal(store.get(fork.id).status, 'cancelled');
  await engine.stop();
});

test('Auto retries corrected preflight and tracks publication per follow-up cycle', async (t) => {
  const { store } = await fixture(t);
  let calls = 0;
  const engine = { running: new Map(), manualRuns: new Map(), actionLocks: new Set() };
  const auto = new WorkflowAutomation(
    store,
    engine,
    {
      start: async () => {
        if (++calls === 1) throw new Error('Missing publishing tool');
      },
    },
    { interval: 60000 },
  );
  t.after(() => auto.stop());
  const task = newTask({ title: 'Publication cycles', demo: true }, DEFAULT_CONFIG);
  task.demo = false;
  task.status = 'completed';
  store.save(task);
  auto.configure(task.id, { enabled: true, scope: 'draft_pr' });
  await auto.tick();
  assert.match(automationState(store, task.id).error, /Missing publishing tool/);
  assert.equal(automationState(store, task.id).publicationReceipts, undefined);
  auto.configure(task.id, { enabled: true, scope: 'draft_pr' });
  await auto.tick();
  await auto.tick();
  assert.equal(calls, 2);
  task.followUpContext = { id: 'new-cycle' };
  store.save(task);
  await auto.tick();
  await auto.tick();
  assert.equal(calls, 3);
});

test('revoked Auto authorization cannot approve or accept a task', async (t) => {
  const { store } = await fixture(t);
  const engine = new Engine(store);
  const auto = new WorkflowAutomation(store, engine, {}, { interval: 60000 });
  t.after(async () => {
    await auto.stop();
    await engine.stop();
  });
  const task = newTask({ title: 'Delegation revocation', demo: true }, DEFAULT_CONFIG);
  task.status = 'awaiting_plan';
  task.attempts = [
    { id: 'plan', stage: 'plan', status: 'complete', handoff: demoHandoff(task, 'plan') },
  ];
  store.save(task);
  const grant = auto.configure(task.id, { enabled: true });
  auto.configure(task.id, { enabled: false });
  await assert.rejects(
    engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary', automation: grant }),
    /delegation changed/,
  );
  task.status = 'awaiting_final';
  store.save(task);
  await assert.rejects(
    engine.action(task.id, 'accept', { automation: grant }),
    /delegation changed/,
  );
  assert.equal(store.get(task.id).status, 'awaiting_final');
});

test('recommendation displays and selectors exclude diagnostic plans', async () => {
  const { completedPlan } = await import('../public/workflow-plan.js');
  const { planOptions } = await import('../public/plan-options.js');
  const { decisionBrief } = await import('../public/workflow-insights.js');
  const task = newTask({ title: 'Second option recommendation', demo: true }, DEFAULT_CONFIG);
  task.status = 'awaiting_plan';
  const plan = demoHandoff(task, 'plan');
  plan.recommendedOptionId = 'patch-callers';
  plan.recommendationReason = 'These consumers intentionally diverge.';
  task.attempts = [
    { stage: 'plan', status: 'complete', handoff: plan },
    { stage: 'plan', status: 'complete', role: 'debug', handoff: { ...plan, options: [] } },
  ];
  assert.equal(completedPlan(task), plan);
  assert.equal(decisionBrief(task).recommendation, plan.options[1].title);
  const markup = planOptions(plan.options, plan.recommendedOptionId);
  assert.match(markup, /value="patch-callers" checked/);
  assert.equal((markup.match(/<em>Recommended<\/em>/g) ?? []).length, 1);
  assert.equal(planOptions(plan.options).includes('<em>Recommended</em>'), false);
  task.followUpContext = { id: 'next-cycle', startedAt: new Date().toISOString() };
  assert.equal(completedPlan(task), undefined);
});

test('checkpoint continuations preserve follow-up scope and current proposal', async (t) => {
  const { store } = await fixture(t);
  const { completedPlan } = await import('../public/workflow-plan.js');
  const source = newTask({ title: 'Original accepted ticket', demo: true }, DEFAULT_CONFIG);
  const startedAt = '2026-01-01T00:00:00.000Z';
  source.followUpContext = { id: 'follow-up', startedAt, request: 'Adjust the new behavior only.' };
  source.followUps = [source.followUpContext];
  source.status = 'awaiting_plan';
  source.stage = 'plan';
  const handoff = demoHandoff(source, 'plan');
  source.attempts = [
    {
      id: 'current-plan',
      followUpId: 'follow-up',
      stage: 'plan',
      status: 'complete',
      startedAt,
      handoff,
    },
  ];
  store.save(source);
  const saved = await captureCheckpoint(store, source, source.attempts[0]);
  const fork = await forkCheckpoint(store, source.id, saved.id, { stage: 'approach' });
  assert.deepEqual(fork.followUpContext, source.followUpContext);
  assert.deepEqual(fork.followUps, source.followUps);
  assert.equal(fork.attempts[0].followUpId, 'follow-up');
  assert.deepEqual(completedPlan(fork), handoff);
  assert.match(buildPrompt(fork, 'implement'), /FOLLOW-UP WORK/);
  assert.ok(buildPrompt(fork, 'implement').includes(source.followUpContext.request));
  fork.attempts.push({
    id: 'wrong-cycle',
    followUpId: 'unrelated-cycle',
    stage: 'plan',
    status: 'complete',
    startedAt: '2026-01-02T00:00:00.000Z',
    handoff: { ...handoff, summary: 'Wrong proposal' },
  });
  assert.deepEqual(completedPlan(fork), handoff);
});
