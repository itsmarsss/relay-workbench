import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { WorkspaceAgent } from '../server/workspace-agent.js';
import { readTaskFilters } from '../public/task-filters-route.js';
test('workspace tools create drafts and preserve workflow approvals', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-workspace-agent-'));
  const store = new Store(directory);
  const engine = new Engine(store);
  const agent = new WorkspaceAgent(store, engine);
  t.after(async () => {
    await agent.stop();
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.config.repositories = [
    {
      id: 'example',
      name: 'Example',
      path: directory,
      strategy: 'worktree',
      checks: [],
      setup: [],
      instructions: '',
    },
  ];
  await assert.rejects(agent.tool('list_tasks'), /No workspace agent/);
  agent.controller = new AbortController();
  agent.created = 0;
  const draft = await agent.tool('create_draft', {
    title: 'Investigate defaults',
    description: 'Read both callers.',
    repositoryIds: ['example'],
    ticket: 'https://example.org/issues/42',
  });
  assert.equal(draft.status, 'draft');
  assert.equal(store.get(draft.id).workspace, null);
  assert.deepEqual(store.get(draft.id).approvals, []);
  assert.equal(engine.running.size, 0);
  const reused = await agent.tool('create_draft', {
    title: 'Duplicate',
    description: 'Repeat',
    repositoryIds: ['example'],
    ticket: 'https://example.org/issues/42',
  });
  assert.equal(reused.id, draft.id);
  assert.equal(store.all().length, 1);
  await assert.rejects(agent.tool('start', { id: draft.id }), /Unsupported workspace tool/);
  await assert.rejects(
    agent.tool('create_draft', {
      title: 'Bad',
      description: 'Bad',
      repositoryIds: ['example'],
      demo: true,
    }),
    /Unsupported workspace tool/,
  );
  assert.equal((await agent.tool('list_tasks')).tasks[0].status, 'draft');
});
test('task filter URLs preserve search, project, layout and sorting', () => {
  const filters = readTaskFilters(
    '#tasks?q=some%20text&repo=example&sort=title&layout=board&empty=1',
  );
  assert.equal(filters.search, 'some text');
  assert.equal(filters.repositoryFilter, 'example');
  assert.equal(filters.taskSort, 'title');
  assert.equal(filters.taskLayout, 'board');
  assert.equal(filters.showEmptyStages, true);
  assert.equal(readTaskFilters('#tasks?sort=invalid').taskSort, 'priority');
  assert.equal(readTaskFilters('#tasks').search, '');
});

test('workspace HTTP capabilities cannot start tasks or bypass session auth', async (t) => {
  const { createApp } = await import('../server/app.js');
  const directory = await mkdtemp(join(tmpdir(), 'relay-workspace-http-'));
  let observed;
  const app = createApp({
    directory,
    publicDirectory: process.cwd() + '/public',
    engineOptions: {
      workspaceAgentRun: async (_command, args, options) => {
        const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
        const [, origin, capability] = config.mcpServers.relay_workspace.args;
        const headers = { 'Content-Type': 'application/json', 'X-Relay-Workspace': capability };
        const tool = async (name, input = {}) => {
          const response = await fetch(origin + '/api/workspace-agent/tool', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name, args: input }),
          });
          return { status: response.status, data: await response.json() };
        };
        const draft = await tool('create_draft', {
          title: 'Imported issue',
          description: 'Issue context from the board.',
          repositoryIds: ['example'],
        });
        assert.equal(draft.status, 200);
        assert.equal(draft.data.status, 'draft');
        assert.equal((await tool('start', { id: draft.data.id })).status, 400);
        const forbidden = await fetch(origin + '/api/tasks', {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'No access', demo: true }),
        });
        assert.equal(forbidden.status, 403);
        observed = await tool('list_tasks');
        options.onLine(
          JSON.stringify({ type: 'result', result: 'Created a draft for your review.' }),
          'stdout',
        );
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  app.store.config.harnesses.claude = {
    command: process.execPath,
    enabled: true,
    model: 'test-model',
  };
  app.store.config.repositories = [
    {
      id: 'example',
      name: 'Example',
      path: directory,
      strategy: 'worktree',
      checks: [],
      setup: [],
      instructions: '',
    },
  ];
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await fetch(origin + '/api/bootstrap').then((response) => response.json());
  const rejected = await fetch(origin + '/api/workspace-agent/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token },
    body: JSON.stringify({ name: 'list_tasks' }),
  });
  assert.equal(rejected.status, 403);
  const response = await fetch(origin + '/api/workspace-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token },
    body: JSON.stringify({ question: 'Prepare this issue as a draft.' }),
  });
  assert.equal(response.status, 202);
  let history;
  for (let i = 0; i < 100; i++) {
    history = await fetch(origin + '/api/workspace-agent').then((response) => response.json());
    if (history[0]?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(history[0].status, 'complete', history[0].error);
  assert.equal(observed.data.tasks.length, 1);
  assert.equal(app.engine.running.size, 0);
  assert.equal(app.store.all()[0].status, 'draft');
});
