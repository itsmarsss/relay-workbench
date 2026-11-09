import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { WorkspaceAgent, workspaceTools } from '../server/workspace-agent.js';
import { WorkflowAutomation, automationState } from '../server/workflow-automation.js';
import {
  proposeTaskChanges,
  decideTaskProposal,
  taskProposals,
  recoverTaskProposals,
} from '../server/task-proposals.js';
import { captureCheckpoint } from '../server/workflow-checkpoints.js';
import { demoHandoff } from '../server/harness.js';
import { taskProposalChange } from '../public/task-proposal-view.js';
import { createApp } from '../server/app.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-chat-controls-'));
  const store = new Store(directory),
    engine = new Engine(store);
  engine.tick = () => {};
  const agent = new WorkspaceAgent(store, engine);
  agent.controller = new AbortController();
  const automation = new WorkflowAutomation(store, engine, {}, { interval: 600000 });
  const feedback = { jobs: new Map() },
    monitor = {};
  const decide = (id, decision = 'approve', services = {}) =>
    decideTaskProposal(store, engine, feedback, monitor, id, decision, () => false, {
      automation,
      ...services,
    });
  const propose = (task, change) =>
    proposeTaskChanges(store, [{ taskId: task.id, ...change }], 'User-requested change', 'message');
  t.after(async () => {
    await agent.stop();
    await automation.stop();
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, engine, agent, automation, monitor, propose, decide };
}
test('Auto delegation requires human approval and stale or revoked requests never apply', async (t) => {
  const { store, engine, agent, propose, decide, automation } = await fixture(t);
  const task = engine.create({ title: 'Enable Auto', demo: true });
  const proposal = await agent.tool('propose_task_changes', {
    reason: 'Finish through a draft PR',
    changes: [{ taskId: task.id, operation: 'automation', enabled: true, scope: 'draft_pr' }],
  });
  assert.equal(automationState(store, task.id).enabled, false);
  assert.equal((await agent.tool('get_task', { id: task.id })).automation.enabled, false);
  await assert.rejects(agent.tool('enable_auto', { id: task.id }), /Unsupported/);
  await decide(proposal.id);
  assert.equal(automationState(store, task.id).scope, 'draft_pr');
  assert.equal(automationState(store, task.id).enabled, true);
  await assert.rejects(decide(proposal.id), /changed/);
  const disable = propose(task, { operation: 'automation', enabled: false, scope: 'reviewed' });
  engine.actionLocks.add(task.id);
  await decide(disable.id);
  engine.actionLocks.delete(task.id);
  assert.equal(automationState(store, task.id).enabled, false);
  automation.configure(task.id, { enabled: true, scope: 'draft_pr' });
  const stale = propose(task, { operation: 'automation', enabled: false, scope: 'reviewed' });
  engine.update(task.id, { title: 'New scope', expectedRevision: 0 });
  await assert.rejects(decide(stale.id), /changed/);
  const revoked = propose(store.get(task.id), {
    operation: 'automation',
    enabled: false,
    scope: 'reviewed',
  });
  store.config.workspaceAgent.permissions.proposeTasks = false;
  await assert.rejects(decide(revoked.id), /permission/);
  assert.equal(automationState(store, task.id).enabled, true);
});
test('checkpoint proposals restore saved choices, retain originals and expose continuation links', async (t) => {
  const { store, engine, agent, propose, decide } = await fixture(t);
  const task = engine.create({ title: 'Saved choices', demo: true });
  task.stage = 'plan';
  task.status = 'awaiting_plan';
  task.attempts = [
    { id: 'saved-plan', stage: 'plan', status: 'complete', handoff: demoHandoff(task, 'plan') },
  ];
  store.save(task);
  const point = await captureCheckpoint(store, task, task.attempts[0]);
  const details = await agent.tool('get_task', { id: task.id });
  assert.equal(details.history.checkpoints[0].id, point.id);
  const proposal = propose(task, {
    operation: 'checkpoint',
    checkpointId: point.id,
    stage: 'approach',
    note: 'Prefer another remedy',
  });
  assert.equal(store.all().length, 1);
  const applied = await decide(proposal.id);
  const fork = store.get(applied.results[0].taskId);
  assert.equal(fork.status, 'awaiting_plan');
  assert.ok(fork.attempts.every((a) => a.inherited));
  assert.equal(automationState(store, fork.id).enabled, false);
  assert.equal(store.get(task.id).status, 'awaiting_plan');
  assert.equal(applied.results[0].url, `#task/${fork.id}/overview`);
  agent.controller = null;
  assert.match(agent.recordTaskApproval('yes', proposal).answer, /@Continuation/);
});
test('task settings use editor rules and preserve unrelated runtime overrides', async (t) => {
  const { store, engine, propose, decide } = await fixture(t);
  const task = engine.create({ title: 'Tune task', demo: true });
  task.execution.timeoutMinutes = 40;
  task.status = 'paused';
  store.save(task);
  const proposal = propose(task, {
    operation: 'settings',
    settings: { execution: { maxRepairRounds: 3 }, models: { implement: 'custom-model' } },
  });
  await decide(proposal.id);
  assert.equal(store.get(task.id).execution.timeoutMinutes, 40);
  assert.equal(store.get(task.id).execution.maxRepairRounds, 3);
  assert.equal(store.get(task.id).models.implement, 'custom-model');
  task.status = 'running';
  store.save(task);
  assert.throws(() => propose(task, { operation: 'settings', settings: { models: {} } }), /Pause/);
});
test('workflow actions execute exact approved choices and never accept injected automation data', async (t) => {
  const { store, engine, propose, decide } = await fixture(t);
  const task = engine.create({ title: 'Revise saved proposal', demo: true });
  task.status = 'awaiting_plan';
  task.stage = 'plan';
  task.attempts = [
    { id: 'plan', stage: 'plan', status: 'complete', handoff: demoHandoff(task, 'plan') },
  ];
  store.save(task);
  assert.throws(
    () =>
      propose(task, {
        operation: 'workflow',
        action: 'approve-plan',
        data: { optionId: 'shared-boundary', automation: { authorizationId: 'fake' } },
      }),
    /Unsupported/,
  );
  const proposal = propose(task, {
    operation: 'workflow',
    action: 'request-changes',
    data: { note: 'Explain compatibility first' },
  });
  await decide(proposal.id);
  assert.equal(store.get(task.id).status, 'queued');
  assert.match(store.get(task.id).messages.at(-1).text, /Explain compatibility/);
  assert.equal(store.get(task.id).chosenApproach, null);
});
test('pause can stop active work while a failed restore cannot launch a debugger', async (t) => {
  const { store, engine, propose, decide } = await fixture(t);
  const task = engine.create({ title: 'Stop active work', demo: true });
  task.status = 'running';
  store.save(task);
  const controller = new AbortController();
  engine.running.set(task.id, controller);
  const proposal = propose(task, { operation: 'workflow', action: 'pause' });
  await decide(proposal.id);
  assert.equal(controller.signal.aborted, true);
  engine.running.delete(task.id);
  task.status = 'blocked';
  task.checkpointRestore = { status: 'failed' };
  store.save(task);
  assert.throws(() => propose(task, { operation: 'workflow', action: 'debug' }), /restoring/);
  const cancel = propose(task, { operation: 'workflow', action: 'cancel' });
  await decide(cancel.id);
  assert.equal(store.get(task.id).status, 'cancelled');
});
test('async approvals are single-use and do not overwrite newer proposals', async (t) => {
  const { store, engine, propose, decide } = await fixture(t);
  const task = engine.create({ title: 'Publish accepted work', demo: true });
  task.demo = false;
  task.status = 'completed';
  store.save(task);
  let release, began;
  const ready = new Promise((r) => (began = r)),
    wait = new Promise((r) => (release = r));
  const services = {
    publication: {
      start: async () => {
        began();
        await wait;
      },
    },
  };
  const proposal = propose(task, { operation: 'publish', repositoryId: task.repository.id });
  const applying = decide(proposal.id, 'approve', services);
  await ready;
  assert.equal(taskProposals(store).find((p) => p.id === proposal.id).status, 'applying');
  await assert.rejects(decide(proposal.id, 'approve', services), /changed/);
  const another = engine.create({ title: 'Other task', demo: true });
  const newer = propose(another, { operation: 'automation', enabled: true, scope: 'reviewed' });
  release();
  await applying;
  assert.equal(taskProposals(store).find((p) => p.id === newer.id).status, 'pending');
  assert.equal(taskProposals(store).find((p) => p.id === proposal.id).status, 'approved');
});
test('interrupted and failed action receipts require fresh proposals, never blind replay', async (t) => {
  const { store, engine, propose, decide } = await fixture(t);
  const task = engine.create({ title: 'Publication failure', demo: true });
  task.demo = false;
  task.status = 'completed';
  store.save(task);
  const proposal = propose(task, { operation: 'publish', repositoryId: task.repository.id });
  await assert.rejects(
    decide(proposal.id, 'approve', {
      publication: {
        start: async () => {
          throw Error('Inspect remote outcome');
        },
      },
    }),
    /remote outcome/,
  );
  await assert.rejects(decide(proposal.id), /changed/);
  const values = taskProposals(store);
  values[0].status = 'applying';
  store.db
    .prepare('UPDATE meta SET value=? WHERE key=?')
    .run(JSON.stringify(values), 'workspace-task-proposals');
  recoverTaskProposals(store);
  assert.equal(taskProposals(store)[0].status, 'failed');
  assert.match(taskProposals(store)[0].error, /restarted/);
});
test('read tools expose workflow evidence, model catalogs and correct single-worktree paths', async (t) => {
  const { store, engine, agent, directory } = await fixture(t);
  const task = engine.create({ title: 'Read evidence', demo: true });
  task.workspaceRoot = directory;
  task.branch = 'test-branch';
  task.blockerDecision = { id: 'blocker', options: [] };
  store.save(task, { type: 'checkpoint', summary: 'Saved evidence' });
  const details = await agent.tool('get_task', { id: task.id });
  assert.equal(details.repositories[0].workspaceRoot, directory);
  assert.equal(details.blockerDecision.id, 'blocker');
  const events = await agent.tool('read_task_activity', { id: task.id, after: 0, limit: 1 });
  assert.equal(
    (await agent.tool('read_task_activity', { id: task.id, limit: 1 })).events[0].summary,
    'Saved evidence',
  );
  assert.equal(events.events.length, 1);
  assert.ok(events.nextAfter > 0);
  assert.ok(
    (await agent.tool('read_task_activity', { id: task.id, after: events.nextAfter })).events.some(
      (e) => e.summary === 'Saved evidence',
    ),
  );
  await assert.rejects(
    agent.tool('read_task_activity', { id: task.id, limit: 101 }),
    /valid activity/,
  );
  assert.equal((await agent.tool('read_task_changes', { id: task.id })).demo, true);
  agent.modelCatalog = {
    provider: async () => ({ models: [{ id: 'fixture-model' }], status: 'ready' }),
  };
  store.config.harnesses.claude.enabled = true;
  assert.equal(
    (await agent.tool('read_model_catalog', { provider: 'claude' })).models[0].id,
    'fixture-model',
  );
  store.config.workspaceAgent.permissions.readSettings = false;
  assert.equal((await agent.tool('get_task', { id: task.id })).automation, undefined);
  await assert.rejects(
    agent.tool('read_model_catalog', { provider: 'claude' }),
    /Permission disabled/,
  );
  assert.ok(agent.context().capabilities.propose.includes('Auto scope'));
  assert.ok(workspaceTools.some((tool) => tool.name === 'read_task_changes'));
});
test('action previews identify scope and do not mislabel new operations as feedback', () => {
  assert.match(
    taskProposalChange({ operation: 'automation', scope: 'draft_pr', enabled: true }).scope,
    /draft PR/,
  );
  assert.match(
    taskProposalChange({ operation: 'checkpoint', stage: 'approach' }).originalWork,
    /not inherited/,
  );
  assert.equal(taskProposalChange({ operation: 'workflow', action: 'accept' }).operation, 'accept');
  assert.equal(taskProposalChange({ operation: 'publish' }).operation, 'Run publication agent');
});
test('HTTP Auto proposals require a human session and execute through the real Auto service', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-controls-http-'));
  const app = createApp({ directory, publicDirectory: resolve('public') });
  app.engine.tick = () => {};
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = app.engine.create({ title: 'Human authorization', demo: true });
  const proposal = proposeTaskChanges(
    app.store,
    [{ taskId: task.id, operation: 'automation', enabled: true, scope: 'reviewed' }],
    'Finish this task',
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = (await fetch(base + '/api/bootstrap').then((r) => r.json())).token;
  const post = (authorized) =>
    fetch(`${base}/api/workspace-agent/task-proposals/${proposal.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { 'X-Relay-Token': token } : { 'X-Relay-Workspace': 'no-user-token' }),
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
  assert.equal((await post(false)).status, 403);
  assert.equal(automationState(app.store, task.id).enabled, false);
  assert.equal((await post(true)).status, 200);
  assert.equal(automationState(app.store, task.id).enabled, true);
});

test('invalid options, hidden directions and design retries cannot become approval requests', async (t) => {
  const { store, engine, propose } = await fixture(t);
  const task = engine.create({ title: 'Approval boundaries', demo: true });
  task.status = 'awaiting_plan';
  task.stage = 'plan';
  task.attempts = [
    { id: 'plan', stage: 'plan', status: 'complete', handoff: demoHandoff(task, 'plan') },
  ];
  store.save(task);
  assert.throws(
    () =>
      propose(task, {
        operation: 'workflow',
        action: 'approve-plan',
        data: { optionId: 'invented' },
      }),
    /current proposed/,
  );
  task.messages.push({ delivery: 'pending', text: 'New constraint' });
  store.save(task);
  assert.throws(
    () =>
      propose(task, {
        operation: 'workflow',
        action: 'approve-plan',
        data: { optionId: 'shared-boundary' },
      }),
    /pending direction/,
  );
  task.status = 'blocked';
  task.messages = [];
  task.blockerDecision = { id: 'blocker', options: [] };
  store.save(task);
  assert.throws(
    () =>
      propose(task, {
        operation: 'workflow',
        action: 'resolve-blocker',
        data: { decisionId: 'blocker', resolution: 'retry', optionId: 'design-alternative' },
      }),
    /revised plan/,
  );
  assert.throws(
    () => propose(task, { operation: 'workflow', action: 'debug', data: { note: 'hidden data' } }),
    /Unsupported/,
  );
  assert.throws(() => proposeTaskChanges(store, [null], 'Invalid'), /Invalid task/);
  assert.throws(() => propose(task, { operation: '__proto__' }), /Unsupported task change/);
});
