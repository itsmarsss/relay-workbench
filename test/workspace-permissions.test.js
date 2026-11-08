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
