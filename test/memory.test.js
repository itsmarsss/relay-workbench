import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { newTask, DEFAULT_CONFIG, handoffSchema } from '../server/domain.js';
import {
  createMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  selectMemories,
  memoryContext,
  proposeMemories,
} from '../server/memory.js';
import { buildPrompt } from '../server/harness.js';
import { questionContext } from '../server/side-questions.js';
import { memoryPage, runMemories } from '../public/memory.js';

const preference = (title, extra = {}) => ({
  scope: 'global',
  kind: 'preference',
  title,
  content: `${title} content`,
  ...extra,
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-memory-'));
  const store = new Store(directory);
  store.config.repositories = [
    { id: 'one', name: 'One' },
    { id: 'two', name: 'Two' },
  ];
  const task = newTask({ title: 'Memory boundaries', demo: true }, DEFAULT_CONFIG);
  task.repository = { ...task.repository, id: 'one' };
  store.save(task);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, task, directory };
}
test('memory selection isolates scopes, approval, expiry and observation authority', async (t) => {
  const { store, task } = await fixture(t);
  const global = createMemory(store, preference('Global'));
  const project = createMemory(store, preference('Project', { scope: 'project', targetId: 'one' }));
  const scoped = createMemory(store, preference('Task', { scope: 'task', targetId: task.id }));
  createMemory(store, preference('Foreign project', { scope: 'project', targetId: 'two' }));
  createMemory(store, preference('Pending', { status: 'proposed' }));
  createMemory(store, preference('Disabled', { status: 'disabled' }));
  createMemory(store, preference('Expired', { expiresAt: '2000-01-01T00:00:00Z' }));
  const observation = createMemory(store, preference('Observation', { kind: 'observation' }));
  const selected = selectMemories(store, task);
  assert.equal(selected[0].id, scoped.id);
  assert.equal(selected[1].id, project.id);
  assert.deepEqual(
    new Set(selected.map((m) => m.id)),
    new Set([scoped.id, project.id, global.id, observation.id]),
  );
  assert.equal(
    selectMemories(store, task, ['two']).some((m) => m.id === project.id),
    false,
  );
  const context = memoryContext(store, task);
  const prompt = buildPrompt({ ...task, memorySnapshot: context }, 'implement');
  assert.ok(prompt.includes('current explicit user direction'));
  assert.ok(prompt.includes('Observations are dated, fallible evidence'));
  assert.ok(prompt.includes('Global content'));
  assert.ok(!prompt.includes('Foreign project content'));
  assert.deepEqual(questionContext(store, task).memorySnapshot, context);
  assert.ok(handoffSchema('review').properties.memorySuggestions);
  assert.equal(
    handoffSchema('verify').properties.verification.properties.checks.items.properties
      .memorySuggestions,
    undefined,
  );
});
test('agent proposals never activate themselves and retain provenance after human approval', async (t) => {
  const { store, task } = await fixture(t);
  const attempt = { id: 'attempt', harness: 'codex', actualModel: 'example-model' };
  const suggestion = preference('Proposed', {
    status: 'active',
    scope: 'project',
    repositoryId: 'one',
    evidence: 'Measured on a particular host',
  });
  const [memory] = proposeMemories(store, task, attempt, [suggestion]);
  assert.equal(memory.status, 'proposed');
  assert.equal(memory.approvedAt, null);
  assert.equal(memory.source.attemptId, 'attempt');
  assert.equal(selectMemories(store, task).length, 0);
  assert.equal(proposeMemories(store, task, attempt, [suggestion]).length, 0);
  assert.equal(
    proposeMemories(store, task, attempt, [{ ...suggestion, repositoryId: 'two' }]).length,
    0,
  );
  assert.equal(proposeMemories(store, task, attempt, { content: 'malformed' }).length, 0);
  const active = updateMemory(store, memory.id, { revision: 1, status: 'active' });
  assert.equal(active.approvedRevision, 2);
  assert.equal(active.source.type, 'agent');
  const snapshot = memoryContext(store, task);
  updateMemory(store, memory.id, { revision: 2, content: 'Changed by human' });
  assert.equal(snapshot.entries[0].content, suggestion.content);
  assert.throws(
    () => updateMemory(store, memory.id, { revision: 1, status: 'disabled' }),
    /refresh/,
  );
  assert.throws(() => deleteMemory(store, memory.id, 1), /refresh/);
  deleteMemory(store, memory.id, 3);
  assert.equal(listMemories(store).length, 0);
  assert.equal(snapshot.entries[0].revision, 2);
});
test('memory survives restart and context remains bounded without truncating entries', async (t) => {
  const { store, task, directory } = await fixture(t);
  for (let i = 0; i < 30; i++)
    createMemory(store, preference(`Entry ${i}`, { content: 'x'.repeat(1500) }));
  const context = memoryContext(store, task);
  assert.ok(context.omitted > 0);
  assert.ok(context.entries.length < 24);
  assert.ok(context.entries.every((m) => m.content.length === 1500));
  assert.deepEqual(memoryContext(store, task), context);
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(listMemories(reopened).length, 30);
    assert.equal(reopened.get(task.id).title, task.title);
  } finally {
    reopened.close();
  }
});
test('memory HTTP mutations require authentication and validate scope, provenance and revisions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-memory-http-'));
  const app = createApp({
    directory,
    publicDirectory: resolve('public'),
    engineOptions: { demoDelay: 1 },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const token = (await fetch(base + '/bootstrap').then((r) => r.json())).token;
  const request = (path, method, body, auth = true) =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Relay-Token': token } : {}) },
      body: JSON.stringify(body),
    });
  assert.equal((await request('/memories', 'POST', preference('Private'), false)).status, 403);
  assert.equal(
    (await request('/memories', 'POST', preference('Forged', { source: { type: 'user' } }))).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/memories',
        'POST',
        preference('Missing', { scope: 'task', targetId: 'missing' }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await request('/memories', 'POST', preference('Bad expiry', { expiresAt: 'soon' }))).status,
    400,
  );
  const response = await request('/memories', 'POST', preference('<script>Literal</script>'));
  assert.equal(response.status, 201);
  const memory = await response.json();
  const task = app.engine.create({ title: 'Uses memory', demo: true });
  await app.engine.action(task.id, 'start');
  for (let i = 0; i < 100 && app.store.get(task.id).status !== 'awaiting_plan'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const current = app.store.get(task.id);
  assert.equal(current.status, 'awaiting_plan');
  assert.ok(
    current.attempts.every((a) => a.memorySnapshot.entries.some((m) => m.id === memory.id)),
  );
  assert.equal(
    (await request(`/memories/${memory.id}`, 'PATCH', { revision: 1, content: 'Edited' })).status,
    200,
  );
  assert.equal(
    (await request(`/memories/${memory.id}`, 'PATCH', { revision: 1, content: 'Stale' })).status,
    409,
  );
  assert.equal((await request(`/memories/${memory.id}`, 'DELETE', { revision: 2 })).status, 200);
  assert.equal((await fetch(base + '/memories').then((r) => r.json())).length, 0);
  assert.ok(current.attempts[0].memorySnapshot.entries[0].title.includes('<script>'));
  const html = runMemories(current);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>Literal'));
  assert.ok(!memoryPage([memory], DEFAULT_CONFIG, []).includes('<script>Literal'));
});
