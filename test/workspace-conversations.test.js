import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { WorkspaceAgent } from '../server/workspace-agent.js';
import { createApp } from '../server/app.js';

async function fixture(t, run) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-conversations-'));
  const store = new Store(directory);
  const engine = new Engine(store);
  store.config.harnesses.claude.command = process.execPath;
  const agent = new WorkspaceAgent(store, engine, { run });
  t.after(async () => {
    await agent.stopAll();
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { agent, store, engine };
}

test('conversations preserve legacy history and persist independent names and messages', async (t) => {
  const { agent, store, engine } = await fixture(t);
  agent.history = [
    { id: 'old', question: 'Original context', answer: 'Original answer', status: 'complete' },
  ];
  agent.save();
  const chat = agent.createChat('Planning');
  agent.renameChat(chat.id, 'Architecture');
  const child = agent.forChat(chat.id);
  child.history = [
    { id: 'new', question: 'Other context', answer: 'Other answer', status: 'complete' },
  ];
  child.save();
  const reopened = new WorkspaceAgent(store, engine);
  assert.equal(reopened.listChats()[1].title, 'Architecture');
  assert.equal(reopened.history[0].id, 'old');
  assert.equal(reopened.forChat(chat.id).history[0].id, 'new');
  reopened.deleteChat('default');
  assert.equal(reopened.forChat().chatId, chat.id);
  assert.throws(() => reopened.forChat('default'), /Chat not found/);
  assert.throws(() => reopened.deleteChat(chat.id), /at least one chat/);
  assert.throws(() => reopened.renameChat(chat.id, ' '), /Chat title/);
  assert.equal(new WorkspaceAgent(store, engine).history.length, 0);
});

test('conversations run concurrently with isolated context, tools, cancellation and revisions', async (t) => {
  const calls = [];
  const { agent } = await fixture(t, async (_command, _args, options) => {
    calls.push(options);
    await new Promise((resolve) => {
      options.release = resolve;
      options.signal.addEventListener('abort', resolve, { once: true });
    });
    if (options.signal.aborted) throw new Error('Stopped');
    options.onLine(JSON.stringify({ type: 'result', result: 'Finished' }), 'stdout');
    return { code: 0, stderr: '' };
  });
  const chat = agent.createChat('Separate');
  const child = agent.forChat(chat.id);
  agent.history = [
    { id: 'private-a', question: 'Secret alpha', answer: 'alpha', status: 'complete' },
  ];
  child.history = [
    { id: 'private-b', question: 'Secret beta', answer: 'beta', status: 'complete' },
  ];
  await agent.ask('Continue alpha', 'http://localhost');
  await child.ask('Continue beta', 'http://localhost');
  for (let i = 0; calls.length < 2 && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 2);
  assert.equal(agent.runningCount, 2);
  assert.notEqual(agent.capability, child.capability);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  const alpha = calls.find((call) => call.input.endsWith('Continue alpha'));
  const beta = calls.find((call) => call.input.endsWith('Continue beta'));
  assert.doesNotMatch(alpha.input, /Secret beta/);
  assert.doesNotMatch(beta.input, /Secret alpha/);
  assert.deepEqual(await child.tool('search_conversation', { query: 'Secret alpha' }), []);
  assert.throws(() => agent.deleteChat(chat.id), /Stop this chat/);
  await agent.stop();
  assert.equal(child.controller.signal.aborted, false);
  beta.release();
  await child.done;
  assert.equal(child.history.at(-1).status, 'complete');
  await assert.rejects(
    child.ask('Edit alpha', 'http://localhost', 'private-a'),
    /Original message not found/,
  );
});

test('conversation HTTP boundaries validate identifiers and retain separate histories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-chat-http-'));
  const app = createApp({ directory });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await fetch(origin + '/api/bootstrap').then((r) => r.json());
  const request = (path, method = 'GET', data, auth = token) =>
    fetch(origin + '/api/workspace-agent' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': auth },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  assert.equal((await request('/chats', 'POST', { title: 'No auth' }, '')).status, 403);
  assert.equal((await request('/chats', 'POST', { title: '' })).status, 400);
  const response = await request('/chats', 'POST', { title: 'API design' });
  assert.equal(response.status, 201);
  const chat = await response.json();
  assert.equal((await request('?chatId=' + chat.id)).status, 200);
  assert.deepEqual(await (await request('?chatId=' + chat.id)).json(), []);
  assert.equal((await request('?chatId=missing')).status, 404);
  assert.equal((await request('', 'POST', { chatId: 'missing', question: 'Run' })).status, 404);
  assert.equal((await request('/chats/' + chat.id, 'PATCH', { title: 'Renamed' })).status, 200);
  assert.equal((await request('/chats/' + chat.id, 'DELETE')).status, 200);
  assert.equal((await request('?chatId=' + chat.id)).status, 404);
});
