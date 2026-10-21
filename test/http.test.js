import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { DEFAULT_CONFIG } from '../server/domain.js';
import { runProcess } from '../server/process.js';
import { git } from '../server/workspace.js';
import { demoHandoff } from '../server/harness.js';
import http from 'node:http';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-http-'));
  const app = createApp({
    directory: join(directory, 'state'),
    publicDirectory: resolve('public'),
    engineOptions: { demoDelay: 1, ...options },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await fetch(origin + '/api/bootstrap').then((r) => r.json());
  const request = async (path, method = 'GET', data, headers = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': bootstrap.token, ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, app, origin, request };
}
async function waitFor(app, id, status) {
  for (let i = 0; i < 1000; i++) {
    const task = app.store.get(id);
    if (task.status === status) return task;
    if (task.status === 'blocked') throw new Error(task.error);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}

test('HTTP rejects cross-origin, missing token and rebinding hosts', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request('/api/tasks', 'POST', { title: 'x', demo: true }, { 'X-Relay-Token': '' }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.request(
        '/api/tasks',
        'POST',
        { title: 'x', demo: true },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(
      f.origin + '/api/bootstrap',
      { headers: { Host: 'evil.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const index = await fetch(f.origin + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('HTTP creates, retrieves, exports and validates task actions', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/tasks', 'POST', { title: '', demo: true })).status, 400);
  const created = await f.request('/api/tasks', 'POST', { title: 'Demo', demo: true });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await f.request(`/api/tasks/${id}/start`, 'POST', {})).status, 200);
  await waitFor(f.app, id, 'awaiting_plan');
  const events = await f.request(`/api/tasks/${id}/events`);
  assert.ok(events.data.length > 3);
  const exported = await f.request(`/api/tasks/${id}/export`);
  assert.equal(exported.data.task.title, 'Demo');
  assert.equal((await f.request(`/api/tasks/${id}/accept`, 'POST', {})).status, 409);
  assert.equal((await f.request(`/api/tasks/${id}/events?after=-1`)).status, 400);
  assert.equal((await f.request('/api/missing')).status, 404);
});
test('HTTP issue import passes literal ticket arguments and requires JSON', async (t) => {
  const f = await fixture(t);
  const repo = join(f.directory, 'repo');
  await mkdir(repo);
  await git(repo, ['init']);
  const config = structuredClone(DEFAULT_CONFIG);
  config.repositories = [
    {
      id: 'fixture',
      name: 'Fixture',
      path: repo,
      cwd: '.',
      strategy: 'attach',
      checks: [],
      setup: [],
      instructions: '',
      issueCommand: {
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({title:"Imported",body:process.argv[1]}))',
          '{ticket}',
        ],
      },
    },
  ];
  assert.equal((await f.request('/api/config', 'PUT', config)).status, 200);
  const imported = await f.request('/api/tickets/import', 'POST', {
    repositoryId: 'fixture',
    ticket: '123',
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.description, '123');
  assert.equal(
    (
      await f.request('/api/tickets/import', 'POST', {
        repositoryId: 'fixture',
        ticket: '--bad-option',
      })
    ).status,
    400,
  );
});
test('accepted task submission commits changes before provider execution', async (t) => {
  const f = await fixture(t, {
    harness: async ({ task, stage }) => {
      if (stage === 'implement') await writeFile(join(task.workspace, 'value.txt'), 'after');
      return demoHandoff(task, stage);
    },
  });
  const repo = join(f.directory, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'feature/task']);
  await writeFile(join(repo, 'value.txt'), 'before');
  await git(repo, ['add', '.']);
  await runProcess('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'test: initial',
  ]);
  // Identity is supplied through the environment, never persisted to Git configuration.
  const oldName = process.env.GIT_AUTHOR_NAME,
    oldEmail = process.env.GIT_AUTHOR_EMAIL,
    oldCommitName = process.env.GIT_COMMITTER_NAME,
    oldCommitEmail = process.env.GIT_COMMITTER_EMAIL;
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  });
  t.after(() => {
    for (const [key, value] of Object.entries({
      GIT_AUTHOR_NAME: oldName,
      GIT_AUTHOR_EMAIL: oldEmail,
      GIT_COMMITTER_NAME: oldCommitName,
      GIT_COMMITTER_EMAIL: oldCommitEmail,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.repositories = [
    {
      id: 'fixture',
      name: 'Fixture',
      path: repo,
      cwd: '.',
      strategy: 'attach',
      checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      setup: [],
      instructions: '',
      prCommand: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("provider accepted")'],
      },
    },
  ];
  f.app.store.setConfig(config);
  const { data: task } = await f.request('/api/tasks', 'POST', {
    title: 'Update a value',
    repositoryId: 'fixture',
  });
  await f.request(`/api/tasks/${task.id}/start`, 'POST', {});
  await waitFor(f.app, task.id, 'awaiting_plan');
  await f.request(`/api/tasks/${task.id}/approve-plan`, 'POST', { optionId: 'shared-boundary' });
  await waitFor(f.app, task.id, 'awaiting_final');
  await f.request(`/api/tasks/${task.id}/accept`, 'POST', {});
  assert.equal((await f.request(`/api/tasks/${task.id}/submit`, 'POST', {})).status, 202);
  for (let i = 0; i < 1000 && f.app.store.get(task.id).submission.status === 'running'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const done = f.app.store.get(task.id);
  assert.equal(done.submission.status, 'complete', done.submission.error);
  assert.equal(await git(repo, ['log', '-1', '--format=%s']), 'feat: Update a value');
  assert.equal(await git(repo, ['status', '--porcelain']), '');
  assert.match(done.submission.stdout, /provider accepted/);
});
