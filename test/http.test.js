import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { DEFAULT_CONFIG } from '../server/domain.js';
import { runProcess, executableExists } from '../server/process.js';
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

test('multi-repo submission preserves partial outcomes and accepted diffs', async (t) => {
  const f = await fixture(t, {
    harness: async ({ task, stage }) => {
      if (stage === 'implement') await writeFile(join(task.workspace, 'value.txt'), 'after');
      return demoHandoff(task, stage);
    },
  });
  const repositories = [];
  for (const id of ['one', 'two']) {
    const path = join(f.directory, id);
    await mkdir(path);
    await git(path, ['init', '-b', 'feature/task']);
    await writeFile(join(path, 'value.txt'), 'before');
    await git(path, ['add', '.']);
    await git(path, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'test: fixture',
    ]);
    repositories.push({
      id,
      name: id,
      path,
      cwd: '.',
      strategy: 'attach',
      checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      setup: [],
      instructions: '',
      prCommand: {
        command: process.execPath,
        args: ['-e', `console.log('${id} provider');process.exit(${id === 'two' ? 1 : 0})`],
      },
    });
  }
  const identity = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  };
  const old = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  t.after(() => {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  f.app.store.setConfig({ ...DEFAULT_CONFIG, repositories });
  const task = f.app.engine.create({ title: 'Coordinate values', repositoryIds: ['one', 'two'] });
  await f.app.engine.action(task.id, 'start');
  await waitFor(f.app, task.id, 'awaiting_plan');
  await f.app.engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  await waitFor(f.app, task.id, 'awaiting_final');
  await f.app.engine.action(task.id, 'accept');
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/submit`, 'POST', { repositoryId: 'unknown' })).status,
    400,
  );
  const submit = async (repositoryId) => {
    const result = await f.request(`/api/tasks/${task.id}/submit`, 'POST', { repositoryId });
    assert.equal(result.status, 202, JSON.stringify(result.data));
    for (let i = 0; i < 1000; i++) {
      const current = f.app.store
        .get(task.id)
        .repositories.find((e) => e.repository.id === repositoryId);
      if (current.submission.status !== 'running') return current.submission;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Submission timeout');
  };
  assert.equal((await submit('one')).status, 'complete');
  // A commit in one repository must not invalidate the other accepted diff.
  assert.equal((await submit('two')).status, 'failed');
  const final = f.app.store.get(task.id);
  assert.equal(final.repositories[0].submission.status, 'complete');
  assert.equal(final.repositories[1].submission.status, 'failed');
  assert.ok(final.repositories.every((e) => e.submission.commit));
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/submit`, 'POST', { repositoryId: 'one' })).status,
    409,
  );
  assert.equal(f.app.engine.workspaceReservations.size, 0);
});

test('saved transcripts expose historical assistant text to the activity thread', async (t) => {
  const f = await fixture(t);
  const task = f.app.engine.create({ title: 'History', demo: true });
  f.app.store.event(task.id, {
    type: 'transcript',
    stream: 'stdout',
    harness: 'codex',
    text: JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Located the old failure.' },
    }),
  });
  const result = await f.request(`/api/tasks/${task.id}/events`);
  assert.deepEqual(result.data.at(-1).agentMessages, ['Located the old failure.']);
  assert.equal(result.data.at(-1).type, 'transcript');
});

test(
  'terminal preview is scoped to a live task terminal and survives terminal exit',
  { skip: !(await executableExists('tmux')) },
  async (t) => {
    const f = await fixture(t);
    const task = f.app.engine.create({ title: 'Preview fixture', demo: true });
    assert.equal((await f.request(`/api/tasks/${task.id}/terminal-preview`)).status, 400);
    assert.equal(
      (
        await f.request(
          `/api/tasks/${task.id}/terminal-preview?attemptId=unknown&socket=/tmp/other`,
        )
      ).data.available,
      false,
    );
    const controller = new AbortController();
    let terminal;
    const running = runProcess(
      process.execPath,
      [
        '-e',
        'console.log("preview sentinel <script>literal</script>"); setInterval(() => {}, 1000)',
      ],
      {
        cwd: f.directory,
        signal: controller.signal,
        terminal: { name: 'http-preview' },
        onTerminal: (info) => {
          terminal = info;
        },
      },
    );
    const settled = running.catch(() => {});
    t.after(async () => {
      controller.abort();
      await settled;
    });
    for (let i = 0; !terminal && i < 200; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(terminal);
    task.status = 'running';
    task.attempts = [{ id: 'preview-attempt', status: 'running', terminal }];
    f.app.store.save(task);
    let preview;
    for (let i = 0; i < 100; i++) {
      preview = await f.request(`/api/tasks/${task.id}/terminal-preview?attemptId=preview-attempt`);
      if (preview.data.output.includes('preview sentinel')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(preview.data.available, true);
    assert.match(preview.data.output, /preview sentinel <script>literal<\/script>/);
    const other = f.app.engine.create({ title: 'Other task', demo: true });
    assert.equal(
      (await f.request(`/api/tasks/${other.id}/terminal-preview?attemptId=preview-attempt`)).data
        .available,
      false,
    );
    task.status = 'manual';
    task.manual = { ...terminal, active: true };
    f.app.store.save(task);
    assert.equal(
      (await f.request(`/api/tasks/${task.id}/terminal-preview?attemptId=manual`)).data.available,
      true,
    );
    assert.equal(
      (await f.request(`/api/tasks/${task.id}/terminal-preview?attemptId=preview-attempt`)).data
        .available,
      false,
    );
    controller.abort();
    await settled;
    assert.equal(
      (await f.request(`/api/tasks/${task.id}/terminal-preview?attemptId=manual`)).data.available,
      false,
    );
    task.status = 'completed';
    f.app.store.save(task);
    assert.equal(
      (await f.request(`/api/tasks/${task.id}/terminal-preview?attemptId=manual`)).data.available,
      false,
    );
  },
);

test('task PATCH persists configuration with revision and writer guards', async (t) => {
  const f = await fixture(t);
  const task = f.app.engine.create({ title: 'Editable', demo: true });
  const path = `/api/tasks/${task.id}`;
  assert.equal(
    (
      await f.request(
        path,
        'PATCH',
        { expectedRevision: 0, title: 'Changed' },
        { 'X-Relay-Token': '' },
      )
    ).status,
    403,
  );
  const saved = await f.request(path, 'PATCH', {
    expectedRevision: 0,
    title: 'Changed',
    models: { review: 'reviewer' },
    execution: { timeoutMinutes: 14, maxRepairRounds: 4 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.configRevision, 1);
  assert.equal((await f.request(path)).data.title, 'Changed');
  assert.equal(
    (await f.request(path, 'PATCH', { expectedRevision: 0, title: 'Stale' })).status,
    409,
  );
  assert.equal(
    (await f.request(path, 'PATCH', { expectedRevision: 1, workspace: '/tmp/other' })).status,
    400,
  );
  f.app.engine.running.set(task.id, {});
  assert.equal((await f.request(path)).data.executionActive, true);
  assert.equal(
    (await f.request(path, 'PATCH', { expectedRevision: 1, title: 'Race' })).status,
    409,
  );
  f.app.engine.running.delete(task.id);
  f.app.engine.manualRuns.set(task.id, {});
  assert.equal(
    (await f.request(path, 'PATCH', { expectedRevision: 1, title: 'Race' })).status,
    409,
  );
  f.app.engine.manualRuns.delete(task.id);
  await f.app.engine.action(task.id, 'start');
  await waitFor(f.app, task.id, 'awaiting_plan');
  const before = f.app.store.get(task.id);
  const changed = await f.request(path, 'PATCH', {
    expectedRevision: 1,
    description: 'Revised requirements',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.status, 'paused');
  assert.equal(changed.data.stage, 'investigate');
  assert.deepEqual(changed.data.attempts, before.attempts);
  await f.app.engine.action(task.id, 'resume');
  await waitFor(f.app, task.id, 'awaiting_plan');
  assert.equal(f.app.store.get(task.id).chosenApproach, null);
  assert.ok(f.app.store.events(task.id).some((e) => e.type === 'configuration'));
});

test('image attachments validate bytes, protect uploads, and serve durable private files', async (t) => {
  const f = await fixture(t);
  const { token } = await fetch(f.origin + '/api/bootstrap').then((r) => r.json());
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNHkAAAAASUVORK5CYII=',
    'base64',
  );
  const upload = (bytes, type = 'image/png', headers = {}) =>
    fetch(f.origin + '/api/attachments', {
      method: 'POST',
      headers: { 'X-Relay-Token': token, 'Content-Type': type, ...headers },
      body: bytes,
    });
  assert.equal((await upload(png, 'image/png', { 'X-Relay-Token': '' })).status, 403);
  assert.equal((await upload(png, 'image/png', { Origin: 'https://example.test' })).status, 403);
  assert.equal(
    (await upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/svg+xml')).status,
    415,
  );
  assert.equal((await upload(Buffer.from('<script>alert(1)</script>'))).status, 400);
  assert.equal((await upload(png, 'image/jpeg')).status, 400);
  assert.equal((await upload(Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  const giant = Buffer.from(png);
  giant.writeUInt32BE(16001, 16);
  assert.equal((await upload(giant)).status, 400);
  const saved = await upload(png);
  assert.equal(saved.status, 201);
  const attachment = await saved.json();
  assert.equal(attachment.width, 1);
  assert.equal(attachment.height, 1);
  assert.match(attachment.url, /^\/api\/attachments\/[a-f0-9-]{36}\.png$/);
  const result = await fetch(f.origin + attachment.url);
  assert.equal(result.headers.get('content-type'), 'image/png');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(result.headers.get('cache-control'), /private.*immutable/);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
  const head = await fetch(f.origin + attachment.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(png.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const { readImage } = await import('../server/attachments.js');
  assert.deepEqual((await readImage(attachment.url, join(f.directory, 'state'))).bytes, png);
  const { stat, symlink } = await import('node:fs/promises');
  assert.equal(
    (await stat(join(f.directory, 'state', attachment.url.replace('/api/', '')))).mode & 0o777,
    0o600,
  );
  const linked = '/api/attachments/00000000-0000-0000-0000-000000000000.png';
  await writeFile(join(f.directory, 'outside.png'), png);
  await symlink(
    join(f.directory, 'outside.png'),
    join(f.directory, 'state', linked.replace('/api/', '')),
  );
  assert.equal((await f.request(linked)).status, 404);
  assert.equal((await f.request('/api/attachments/not-a-file.png')).status, 404);
  assert.equal((await f.request('/api/attachments/%2e%2e%2fconfig.json')).status, 404);
});

test('HTTP inbox and pending direction preserve the approval gate', async (t) => {
  const f = await fixture(t);
  const { data: task } = await f.request('/api/tasks', 'POST', {
    title: 'Decision fixture',
    demo: true,
  });
  await f.request(`/api/tasks/${task.id}/start`, 'POST', {});
  await waitFor(f.app, task.id, 'awaiting_plan');
  const inbox = await f.request('/api/inbox');
  assert.equal(inbox.data.length, 1);
  assert.equal((await f.request('/api/inbox/seen', 'POST', { key: 'stale' })).status, 409);
  assert.equal(
    (await f.request('/api/inbox/seen', 'POST', { key: inbox.data[0].key })).status,
    200,
  );
  assert.equal((await f.request('/api/inbox')).data[0].seen, true);
  await f.request(`/api/tasks/${task.id}/message`, 'POST', {
    message: 'Include one more constraint',
  });
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/approve-plan`, 'POST', { optionId: 'shared-boundary' }))
      .status,
    409,
  );
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/steer`, 'POST', { message: 'Steer idle task' })).status,
    409,
  );
  assert.equal((await f.request(`/api/tasks/${task.id}/review-comment`, 'POST', {})).status, 409);
  await f.request(`/api/tasks/${task.id}/request-changes`, 'POST', {
    note: 'Revise with the pending constraint',
  });
  await waitFor(f.app, task.id, 'awaiting_plan');
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/approve-plan`, 'POST', { optionId: 'shared-boundary' }))
      .status,
    200,
  );
});
