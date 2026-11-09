import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { WorkspaceAgent } from '../server/workspace-agent.js';
import {
  proposeConfiguration,
  decideConfiguration,
  configurationProposals,
} from '../server/workspace-permissions.js';
import { createMemory } from '../server/memory.js';
import { createApp } from '../server/app.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-permissions-'));
  const store = new Store(directory);
  const engine = new Engine(store);
  const agent = new WorkspaceAgent(store, engine);
  t.after(async () => {
    await agent.stop();
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, engine, agent };
}
test('configuration changes require one exact approval and reject stale requests', async (t) => {
  const { store } = await fixture(t);
  const proposal = proposeConfiguration(
    store,
    [{ path: ['concurrency'], value: 3 }],
    'Allow more independent work',
    'message',
  );
  assert.equal(store.config.concurrency, 2);
  assert.deepEqual(proposal.changes, [{ path: ['concurrency'], before: 2, after: 3 }]);
  decideConfiguration(store, proposal.id, 'approve');
  assert.equal(store.config.concurrency, 3);
  assert.throws(() => decideConfiguration(store, proposal.id, 'approve'), /already been reviewed/);
  const stale = proposeConfiguration(
    store,
    [{ path: ['concurrency'], value: 4 }],
    'A second change',
  );
  store.setConfig({ ...store.config, timeoutMinutes: 30 });
  assert.throws(() => decideConfiguration(store, stale.id, 'approve'), /Settings changed/);
  assert.equal(store.config.concurrency, 3);
  decideConfiguration(store, stale.id, 'reject');
  assert.equal(configurationProposals(store).at(-1).status, 'rejected');
  for (const path of [
    ['__proto__', 'polluted'],
    ['missing'],
    ['workspaceAgent', 'permissions', 'constructor'],
  ])
    assert.throws(() => proposeConfiguration(store, [{ path, value: true }], 'Invalid'));
  assert.throws(
    () => proposeConfiguration(store, [{ path: ['concurrency'], value: 99 }], 'Invalid'),
    /between/,
  );
});
test('workspace capabilities enforce revoked reads, memory scope, and draft permissions', async (t) => {
  const { store, agent } = await fixture(t);
  agent.controller = new AbortController();
  createMemory(store, {
    scope: 'global',
    kind: 'preference',
    title: 'Read current settings',
    content: 'Use fresh evidence.',
    status: 'active',
  });
  createMemory(store, {
    scope: 'global',
    kind: 'observation',
    title: 'Unapproved',
    content: 'Not authoritative.',
    status: 'proposed',
  });
  assert.equal((await agent.tool('read_memory')).memories.length, 1);
  assert.equal((await agent.tool('read_configuration')).configuration.concurrency, 2);
  store.config.workspaceAgent.permissions.readSettings = false;
  store.config.workspaceAgent.permissions.readMemory = false;
  store.config.workspaceAgent.permissions.createDrafts = false;
  await assert.rejects(agent.tool('read_configuration'), /Permission disabled/);
  await assert.rejects(agent.tool('read_memory'), /Permission disabled/);
  await assert.rejects(
    agent.tool('create_draft', { title: 'No', description: 'No', repositoryIds: [] }),
    /Permission disabled/,
  );
  await assert.rejects(
    agent.tool('propose_config_change', {
      reason: 'No',
      changes: [{ path: ['concurrency'], value: 3 }],
    }),
    /Read settings permission/,
  );
  assert.deepEqual(agent.context().configuration, { access: 'disabled' });
  await assert.rejects(agent.tool('approve_config_change', {}), /Unsupported workspace tool/);
});
test('workspace model override and searchable history reach the actual invocation', async (t) => {
  const { store, engine, agent } = await fixture(t);
  store.config.harnesses.claude = {
    enabled: true,
    command: process.execPath,
    model: 'inherited-model',
  };
  store.config.workspaceAgent.model = 'workspace-model';
  store.config.workspaceAgent.effort = 'high';
  agent.history = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    question: `earlier ${i}`,
    answer: `answer ${i}`,
    status: 'complete',
  }));
  let invocation;
  agent.run = async (_command, args, options) => {
    invocation = { args, prompt: options.input };
    options.onLine(JSON.stringify({ type: 'result', result: 'Fresh context received.' }), 'stdout');
    return { code: 0, stderr: '' };
  };
  await agent.ask('What is configured?', 'http://127.0.0.1');
  await agent.done;
  assert.equal(agent.history.length, 41);
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'workspace-model');
  assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], 'high');
  assert.match(invocation.prompt, /CURRENT CAPABILITIES AND KNOWLEDGE/);
  assert.match(invocation.prompt, /configured repository path/);
  agent.controller = new AbortController();
  assert.equal(
    (await agent.tool('search_conversation', { query: 'earlier 0' }))[0].answer,
    'answer 0',
  );
  assert.equal(engine.running.size, 0);
});
test('HTTP approval requires human auth, refuses active workers, and persists settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-permission-http-'));
  const app = createApp({ directory, publicDirectory: resolve('public') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = (await fetch(base + '/api/bootstrap').then((r) => r.json())).token;
  async function request(path, data, authorized = true, method = 'POST') {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { 'X-Relay-Token': token } : { 'X-Relay-Workspace': 'not-a-user-token' }),
      },
      body: JSON.stringify(data),
    });
  }
  const { proposeTaskChanges } = await import('../server/task-proposals.js');
  const draft = app.engine.create({ title: 'Draft settings', demo: true });
  const taskProposal = proposeTaskChanges(
    app.store,
    [{ taskId: draft.id, operation: 'settings', settings: { preset: 'small' } }],
    'Focus scope',
  );
  const taskPath = `/api/workspace-agent/task-proposals/${taskProposal.id}`;
  assert.equal((await request(taskPath, { decision: 'approve' }, false)).status, 403);
  app.engine.running.set(draft.id, new AbortController());
  assert.equal((await request(taskPath, { decision: 'approve' })).status, 409);
  app.engine.running.delete(draft.id);
  assert.equal((await request(taskPath, { decision: 'approve' })).status, 200);
  assert.equal(app.store.get(draft.id).preset, 'small');
  const proposal = proposeConfiguration(
    app.store,
    [{ path: ['concurrency'], value: 3 }],
    'Independent work',
  );
  const path = `/api/workspace-agent/permissions/${proposal.id}`;
  assert.equal((await request(path, { decision: 'approve' }, false)).status, 403);
  app.engine.running.set('worker', new AbortController());
  assert.equal((await request(path, { decision: 'approve' })).status, 409);
  app.engine.running.delete('worker');
  assert.equal((await request(path, { decision: 'approve' })).status, 200);
  assert.equal(app.store.config.concurrency, 3);
  const result = await request(
    '/api/workspace-agent/settings',
    { model: 'chosen-model', permissions: { readMemory: false } },
    true,
    'PATCH',
  );
  assert.equal(result.status, 200);
  assert.equal(app.store.config.workspaceAgent.model, 'chosen-model');
  assert.equal(app.store.config.workspaceAgent.permissions.readMemory, false);
  assert.equal(
    (await request('/api/workspace-agent/settings', { model: 'no' }, false, 'PATCH')).status,
    403,
  );
});

// Task configuration is visible to Relay, but only the human applies proposals.

test('task proposals preview real presets, reject stale batches and require approval', async (t) => {
  const { store, engine, agent } = await fixture(t);
  const { proposeTaskChanges, decideTaskProposal, latestTaskConfirmation } =
    await import('../server/task-proposals.js');
  const first = engine.create({ title: 'First', demo: true }),
    second = engine.create({ title: 'Second', demo: true });
  agent.controller = new AbortController();
  const details = await agent.tool('get_task', { id: first.id });
  assert.ok(details.routing);
  assert.ok(details.developmentAccess);
  assert.equal(details.configRevision, 0);
  const proposal = proposeTaskChanges(
    store,
    [first, second].map((task) => ({
      taskId: task.id,
      operation: 'settings',
      settings: { preset: 'small' },
    })),
    'Use a focused workflow',
    'exchange',
  );
  assert.notEqual(store.get(first.id).preset, 'small');
  assert.equal(
    latestTaskConfirmation(store, [{ id: 'exchange', status: 'complete' }], 'yes').id,
    proposal.id,
  );
  assert.equal(latestTaskConfirmation(store, [{ id: 'other', status: 'complete' }], 'yes'), null);
  assert.equal(latestTaskConfirmation(store, [{ id: 'exchange', status: 'running' }], 'yes'), null);
  assert.equal(
    latestTaskConfirmation(
      store,
      [{ id: 'exchange', status: 'complete' }],
      'yes and start everything',
    ),
    null,
  );
  engine.update(second.id, { preset: 'bugfix', expectedRevision: 0 });
  const feedback = { jobs: new Map() },
    monitor = {};
  await assert.rejects(
    decideTaskProposal(store, engine, feedback, monitor, proposal.id, 'approve'),
    /changed/,
  );
  assert.notEqual(store.get(first.id).preset, 'small');
  await decideTaskProposal(store, engine, feedback, monitor, proposal.id, 'reject');
  const fresh = proposeTaskChanges(
    store,
    [{ taskId: first.id, operation: 'settings', settings: { preset: 'small' } }],
    'Focus scope',
    'next',
  );
  await decideTaskProposal(store, engine, feedback, monitor, fresh.id, 'approve');
  assert.equal(store.get(first.id).preset, 'small');
  await assert.rejects(
    decideTaskProposal(store, engine, feedback, monitor, fresh.id, 'approve'),
    /changed/,
  );
  store.config.workspaceAgent.permissions.readSettings = false;
  assert.equal((await agent.tool('get_task', { id: first.id })).routing, undefined);
  assert.equal((await agent.tool('list_tasks')).tasks[0].models, undefined);
  assert.throws(
    () =>
      proposeTaskChanges(
        store,
        [{ taskId: first.id, operation: 'settings', settings: { preset: 'bugfix' } }],
        'No access',
      ),
    /Read settings/,
  );
  await assert.rejects(agent.tool('approve_task_changes', {}), /Unsupported/);
});

test('partial task routing proposals preserve unrelated overrides', async (t) => {
  const { store, engine } = await fixture(t);
  const { proposeTaskChanges, decideTaskProposal } = await import('../server/task-proposals.js');
  const task = engine.create({ title: 'Preserve stage choices', demo: true });
  engine.update(task.id, {
    routing: { ...task.routing, review: 'codex' },
    models: { review: 'custom-review' },
    expectedRevision: 0,
  });
  const proposal = proposeTaskChanges(
    store,
    [
      {
        taskId: task.id,
        operation: 'settings',
        settings: {
          routing: { implement: 'claude' },
          models: { implement: 'custom-implementation' },
        },
      },
    ],
    'Change implementation only',
  );
  assert.equal(proposal.changes[0].settings.routing.review, 'codex');
  await decideTaskProposal(store, engine, { jobs: new Map() }, {}, proposal.id, 'approve');
  assert.equal(store.get(task.id).routing.review, 'codex');
  assert.equal(store.get(task.id).routing.implement, 'claude');
  assert.equal(store.get(task.id).models.review, 'custom-review');
});

test('configuration approval explicitly rechecks read permission', async (t) => {
  const { store } = await fixture(t);
  const proposal = proposeConfiguration(
    store,
    [{ path: ['concurrency'], value: 3 }],
    'More parallel work',
  );
  store.config.workspaceAgent.permissions.readSettings = false;
  assert.throws(
    () => decideConfiguration(store, proposal.id, 'approve'),
    (error) => error.status === 403 && /Read settings permission/.test(error.message),
  );
  assert.equal(store.config.concurrency, 2);
  assert.equal(configurationProposals(store).find((p) => p.id === proposal.id).status, 'pending');
  decideConfiguration(store, proposal.id, 'reject');
});
