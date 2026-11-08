import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { DEFAULT_CONFIG } from '../server/domain.js';
import { runProcess, executableExists } from '../server/process.js';
import { git, fingerprint } from '../server/workspace.js';
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
      verificationMode: 'commands',
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
  config.repositories[0].issueCommand.args = [
    '-e',
    'process.stdout.write(JSON.stringify({title:"Rich issue",body:"Original requirements",author:{login:"issue-reporter"},comments:[{author:{login:"thread-author"},body:"Important follow-up"}]}))',
  ];
  assert.equal((await f.request('/api/config', 'PUT', config)).status, 200);
  const rich = await f.request('/api/tickets/import', 'POST', {
    repositoryId: 'fixture',
    ticket: '123',
  });
  assert.equal(rich.status, 200);
  assert.match(rich.data.description, /issue-reporter/);
  assert.match(rich.data.description, /Important follow-up/);
  const saved = await f.request('/api/tasks', 'POST', { ...rich.data, demo: true });
  assert.equal(saved.status, 201);
  const retrieved = await f.request(`/api/tasks/${saved.data.id}`);
  assert.equal(retrieved.data.description, rich.data.description);

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
    publicationObserve: async () => ({
      verdict: 'complete',
      summary: 'PR is open',
      details: 'Observed provider status',
      evidence: ['Read PR state'],
      publication: {
        url: 'https://code.example/team/repo/pull/42',
        number: '42',
        title: 'Update a value',
        state: 'open',
        draft: true,
        checks: 'pending',
        review: 'required',
      },
    }),
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
      verificationMode: 'commands',
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
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/publication`, 'POST', { enabled: true })).status,
    409,
  );
  await f.request(`/api/tasks/${task.id}/accept`, 'POST', {});
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/submit`, 'POST', { mode: 'commands' })).status,
    202,
  );
  for (let i = 0; i < 1000 && f.app.store.get(task.id).submission.status === 'running'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const done = f.app.store.get(task.id);
  assert.equal(done.submission.status, 'complete', done.submission.error);
  assert.equal(await git(repo, ['log', '-1', '--format=%s']), 'feat: Update a value');
  assert.equal(await git(repo, ['status', '--porcelain']), '');
  assert.match(done.submission.stdout, /provider accepted/);
  for (let i = 0; i < 1000 && !f.app.store.get(task.id).publication; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.app.store.get(task.id).publication.url, 'https://code.example/team/repo/pull/42');
  assert.equal(f.app.store.get(task.id).publication.checks, 'pending');
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/publication`, 'POST', { enabled: false })).status,
    202,
  );
  assert.equal(f.app.store.get(task.id).publicationMonitor.enabled, false);
  assert.equal(
    (
      await f.request(`/api/tasks/${task.id}/publication`, 'POST', {
        enabled: true,
        repositoryId: 'missing',
      })
    ).status,
    400,
  );
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
      verificationMode: 'commands',
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
    (
      await f.request(`/api/tasks/${task.id}/submit`, 'POST', {
        repositoryId: 'unknown',
        mode: 'commands',
      })
    ).status,
    400,
  );
  const submit = async (repositoryId) => {
    const result = await f.request(`/api/tasks/${task.id}/submit`, 'POST', {
      repositoryId,
      mode: 'commands',
    });
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
    (
      await f.request(`/api/tasks/${task.id}/submit`, 'POST', {
        repositoryId: 'one',
        mode: 'commands',
      })
    ).status,
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

test('HTTP backup preview, confirmation and safety archive preserve local history', async (t) => {
  const f = await fixture(t);
  const { data: task } = await f.request('/api/tasks', 'POST', { title: 'Saved task', demo: true });
  await mkdir(join(f.app.store.directory, 'attachments'), { recursive: true });
  await writeFile(
    join(f.app.store.directory, 'attachments', 'fixture.png'),
    Buffer.from([137, 80, 78, 71]),
  );
  const exported = await f.request('/api/backups', 'POST', {});
  assert.equal(exported.status, 201);
  const archive = await fetch(f.origin + exported.data.downloadUrl);
  assert.equal(archive.headers.get('content-type'), 'application/gzip');
  const data = Buffer.from(await archive.arrayBuffer());
  const token = (await f.request('/api/bootstrap')).data.token;
  const upload = async (bytes) => {
    const response = await fetch(f.origin + '/api/backups/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-Relay-Token': token },
      body: bytes,
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await upload(Buffer.from('invalid gzip'))).status, 400);
  const preview = await upload(data);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.tasks, 1);
  const { data: later } = await f.request('/api/tasks', 'POST', {
    title: 'Later task',
    demo: true,
  });
  assert.equal(
    (await f.request('/api/backups/restore', 'POST', { previewId: preview.data.id })).status,
    409,
  );
  const restored = await f.request('/api/backups/restore', 'POST', {
    previewId: preview.data.id,
    confirm: true,
  });
  assert.equal(restored.status, 200);
  assert.ok(restored.data.safetyBackup.downloadUrl);
  assert.equal(f.app.store.get(later.id), null);
  assert.equal(f.app.store.get(task.id).title, 'Saved task');
  assert.deepEqual(
    await readFile(join(f.app.store.directory, 'attachments', 'fixture.png')),
    Buffer.from([137, 80, 78, 71]),
  );
  assert.equal(
    (await f.request('/api/backups/restore', 'POST', { previewId: preview.data.id, confirm: true }))
      .status,
    409,
  );
  const storage = await f.request('/api/storage');
  assert.equal(storage.status, 200);
  assert.equal(storage.data.backups.length, 2);
  const again = await upload(data);
  assert.equal(
    (await f.request('/api/backups/discard', 'POST', { previewId: again.data.id })).status,
    200,
  );
  assert.equal(
    (await f.request('/api/backups/restore', 'POST', { previewId: again.data.id, confirm: true }))
      .status,
    409,
  );
  assert.equal((await f.request('/api/outcomes')).data.rows.length, 0);
});
test('HTTP maintenance refuses active agents and requires local authorization', async (t) => {
  const f = await fixture(t, { demoDelay: 10000 });
  const { data: task } = await f.request('/api/tasks', 'POST', {
    title: 'Active demo',
    demo: true,
  });
  await f.request(`/api/tasks/${task.id}/start`, 'POST', {});
  assert.equal((await f.request('/api/backups', 'POST', {})).status, 409);
  assert.equal(
    (
      await f.request('/api/storage/cleanup', 'POST', {
        taskId: task.id,
        repositoryId: 'demo',
        token: 'stale',
      })
    ).status,
    409,
  );
  assert.equal((await f.request('/api/backups', 'POST', {}, { 'X-Relay-Token': '' })).status, 403);
});

test(
  'browser terminal requires current manual control and closes stale streams',
  { skip: !(await executableExists('tmux')) },
  async (t) => {
    const f = await fixture(t);
    const task = f.app.engine.create({ title: 'Interactive fixture', demo: true });
    const path = `/api/tasks/${task.id}`;
    const controller = new AbortController();
    let terminal;
    const running = runProcess(
      process.execPath,
      [
        '-e',
        'process.stdin.setRawMode(true);process.stdin.resume();console.log("ready");process.stdin.on("data",d=>console.log(d.toString("hex")))',
      ],
      {
        cwd: f.directory,
        signal: controller.signal,
        terminal: { name: 'http-input', interactive: true },
        onTerminal: (info) => (terminal = info),
      },
    );
    const settled = running.catch(() => {});
    t.after(async () => {
      controller.abort();
      await settled;
    });
    for (let i = 0; !terminal && i < 200; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(terminal);
    const endpoint = `${path}/terminal-input?session=${terminal.session}`;
    assert.equal((await f.request(endpoint, 'POST', { type: 'input', data: 'x' })).status, 409);
    task.status = 'manual';
    task.manual = { ...terminal, active: true };
    f.app.store.save(task);
    assert.equal(
      (await f.request(endpoint, 'POST', { type: 'input', data: 'x' }, { 'X-Relay-Token': '' }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.request(
          endpoint,
          'POST',
          { type: 'input', data: 'x' },
          { Origin: 'https://evil.example' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(`${path}/terminal-input?session=stale`, 'POST', {
          type: 'input',
          data: 'x',
        })
      ).status,
      409,
    );
    assert.equal((await f.request(endpoint, 'POST', { type: 'input', data: '' })).status, 400);
    assert.equal(
      (await f.request(endpoint, 'POST', { type: 'input', data: 'é'.repeat(8192) })).status,
      400,
    );
    assert.equal(
      (await f.request(endpoint, 'POST', { type: 'resize', cols: -1, rows: 30 })).status,
      400,
    );
    for (let i = 0; i < 200; i++) {
      const preview = await f.request(`${path}/terminal-preview?attemptId=manual`);
      if (preview.data.output?.includes('ready')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const stream = await fetch(f.origin + `${path}/terminal-stream?session=${terminal.session}`);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('snapshot')) {
      const result = await reader.read();
      assert.ok(!result.done);
      output += decoder.decode(result.value);
    }
    assert.equal(
      (
        await f.request(endpoint, 'POST', {
          type: 'input',
          data: '`literal` $HOME $(nope)\x1b[A\x03',
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request(endpoint, 'POST', { type: 'resize', cols: 90, rows: 30 })).status,
      200,
    );
    task.status = 'paused';
    task.manual.active = false;
    f.app.store.save(task);
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) output += decoder.decode(result.value);
    }
    assert.match(output, /Terminal control has ended/);
    assert.equal((await f.request(endpoint, 'POST', { type: 'input', data: 'x' })).status, 409);
  },
);

test('blocker decisions require token, current decision and valid action', async (t) => {
  const f = await fixture(t);
  const task = f.app.engine.create({ title: 'Debugger decision fixture', demo: true });
  task.status = 'blocked';
  task.stage = 'implement';
  task.blockerDecision = {
    id: 'current',
    resolved: false,
    options: [],
    summary: 'Needs a runtime',
  };
  f.app.store.save(task);
  const path = `/api/tasks/${task.id}/resolve-blocker`;
  assert.equal(
    (
      await f.request(
        path,
        'POST',
        { decisionId: 'current', resolution: 'pause' },
        { 'X-Relay-Token': '' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.request(path, 'POST', { decisionId: 'stale', resolution: 'pause' })).status,
    409,
  );
  assert.equal(
    (await f.request(path, 'POST', { decisionId: 'current', resolution: 'execute-command' }))
      .status,
    400,
  );
  assert.equal(
    (await f.request(path, 'POST', { decisionId: 'current', resolution: 'pause' })).status,
    200,
  );
  assert.equal(f.app.store.get(task.id).status, 'paused');
  assert.equal(f.app.store.get(task.id).approvals.length, 0);
});

test('side questions require a token and do not enter worker direction', async (t) => {
  const f = await fixture(t, { sideAnswer: async () => 'Snapshot answer' });
  const task = f.app.engine.create({ title: 'Side question', demo: true });
  const path = `/api/tasks/${task.id}/question`;
  assert.equal(
    (await f.request(path, 'POST', { question: 'Why?' }, { 'X-Relay-Token': '' })).status,
    403,
  );
  assert.equal((await f.request(path, 'POST', { question: '' })).status, 400);
  assert.equal((await f.request(path, 'POST', { question: 'Why?' })).status, 202);
  for (let i = 0; i < 100 && f.app.store.get(task.id).sideQuestions[0].status === 'running'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const current = f.app.store.get(task.id);
  assert.equal(current.status, 'draft');
  assert.equal(current.messages.length, 0);
  assert.equal(current.sideQuestions[0].answer, 'Snapshot answer');
});

test('submission defaults to agent publication even with a configured provider command', async (t) => {
  const f = await fixture(t, {
    publicationPublish: async ({ task }) => {
      await git(task.workspaceRoot, ['add', '--all']);
      await git(task.workspaceRoot, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'feat: accepted change',
      ]);
      return {
        verdict: 'complete',
        summary: 'Draft PR published',
        details: 'Read remote head',
        evidence: ['Provider confirms the PR head'],
        risks: [],
        options: [],
        publication: {
          url: 'https://code.example/team/repo/pull/7',
          number: '7',
          title: 'A change',
          state: 'open',
          draft: true,
          checks: 'pending',
          review: 'required',
        },
      };
    },
    publicationObserve: async () => ({
      verdict: 'complete',
      summary: 'PR observed',
      details: 'Read remote',
      evidence: ['Remote read'],
      publication: {
        url: 'https://code.example/team/repo/pull/7',
        number: '7',
        title: 'A change',
        state: 'open',
        draft: true,
        checks: 'pending',
        review: 'required',
      },
    }),
  });
  const root = join(f.directory, 'agent-repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'feature/accepted']);
  await writeFile(join(root, 'value.txt'), 'before');
  await git(root, ['add', '--all']);
  await git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'test: initial',
  ]);
  const baseCommit = await git(root, ['rev-parse', 'HEAD']);
  f.app.store.setConfig({
    ...DEFAULT_CONFIG,
    repositories: [
      {
        id: 'agent',
        name: 'Agent repo',
        path: root,
        cwd: '.',
        strategy: 'attach',
        checks: [],
        setup: [],
        instructions: '',
        prCommand: { command: process.execPath, args: ['-e', 'process.exit(99)'] },
      },
    ],
  });
  const { data: created } = await f.request('/api/tasks', 'POST', {
    title: 'A change',
    repositoryId: 'agent',
  });
  assert.equal((await f.request(`/api/tasks/${created.id}/publish`, 'POST', {})).status, 409);
  const task = f.app.store.get(created.id);
  Object.assign(task, {
    status: 'completed',
    stage: 'review',
    workspaceRoot: root,
    workspace: root,
    branch: 'feature/accepted',
    baseCommit,
  });
  await writeFile(join(root, 'value.txt'), 'accepted');
  task.acceptedFingerprint = await fingerprint(task);
  f.app.store.save(task);
  assert.equal((await f.request(`/api/tasks/${created.id}/submit`, 'POST', {})).status, 202);
  for (let i = 0; i < 1000 && f.app.store.get(created.id).delivery.status === 'running'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const done = f.app.store.get(created.id);
  assert.equal(done.delivery.status, 'complete', done.delivery.details);
  assert.equal(done.publication.url, 'https://code.example/team/repo/pull/7');
  assert.equal(done.status, 'completed');
});

test('manual status overrides persist without changing workflow or approvals', async (t) => {
  const f = await fixture(t);
  const { data: task } = await f.request('/api/tasks', 'POST', {
    title: 'Override status',
    demo: true,
  });
  const before = f.app.store.get(task.id);
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/status-override`, 'POST', { value: 'invalid' })).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        `/api/tasks/${task.id}/status-override`,
        'POST',
        { value: 'completed' },
        { 'X-Relay-Token': '' },
      )
    ).status,
    403,
  );
  const changed = await f.request(`/api/tasks/${task.id}/status-override`, 'POST', {
    value: 'review',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.statusOverride.value, 'review');
  assert.equal(changed.data.status, before.status);
  assert.deepEqual(changed.data.approvals, before.approvals);
  assert.equal((await f.request(`/api/tasks/${task.id}`)).data.statusOverride.value, 'review');
  assert.equal(f.app.store.events(task.id).at(-1).type, 'status_override');
  const cleared = await f.request(`/api/tasks/${task.id}/status-override`, 'POST', { value: null });
  assert.equal(cleared.data.statusOverride, null);
  assert.equal(cleared.data.status, before.status);
});

test('workspace base synchronization requires authentication and valid state', async (t) => {
  const f = await fixture(t);
  const task = f.app.engine.create({ title: 'No workspace yet', demo: true });
  assert.equal(
    (await f.request(`/api/tasks/${task.id}/sync-base`, 'POST', {}, { 'X-Relay-Token': '' }))
      .status,
    403,
  );
  const response = await f.request(`/api/tasks/${task.id}/sync-base`, 'POST', {});
  assert.equal(response.status, 409);
  assert.match(response.data.error, /Pause the task/);
});

test('follow-up HTTP modes require auth and keep questions read-only', async (t) => {
  const f = await fixture(t, { sideAnswer: async () => 'The accepted task context is available.' });
  const task = f.app.engine.create({ title: 'Completed task', demo: true });
  task.status = 'completed';
  f.app.store.save(task);
  const path = `/api/tasks/${task.id}/follow-up`;
  assert.equal(
    (await f.request(path, 'POST', { mode: 'question', message: 'Why?' }, { 'X-Relay-Token': '' }))
      .status,
    403,
  );
  assert.equal((await f.request(path, 'POST', { mode: 'invalid', message: 'Why?' })).status, 400);
  assert.equal(
    (await f.request(path, 'POST', { mode: 'question', message: 'Explain the tradeoffs' })).status,
    202,
  );
  assert.equal(f.app.store.get(task.id).status, 'completed');
  assert.equal(f.app.store.get(task.id).attempts.length, 0);
  assert.equal(f.app.store.get(task.id).sideQuestions.length, 1);
  assert.equal(
    (await f.request(path, 'POST', { mode: 'publication', message: 'Edit the title' })).status,
    409,
  );
});

test('working follow-up authenticates and uses the requested harness', async (t) => {
  let release;
  const f = await fixture(t, {
    followUpRun: async ({ task, harness, signal }) => {
      await new Promise((resolve) => {
        release = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      });
      assert.equal(harness, 'pi');
      return {
        ...demoHandoff(task, 'investigate'),
        followUpAction: 'complete',
        summary: 'Requested update finished',
      };
    },
  });
  const root = join(f.directory, 'followup-repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'feature/followup']);
  await writeFile(join(root, 'value.txt'), 'accepted');
  await git(root, ['add', '.']);
  await git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'test: accepted work',
  ]);
  const task = f.app.engine.create({ title: 'Accepted work', demo: true });
  Object.assign(task, {
    demo: false,
    status: 'completed',
    workspace: root,
    workspaceRoot: root,
    branch: 'feature/followup',
    baseCommit: await git(root, ['rev-parse', 'HEAD']),
  });
  f.app.store.save(task);
  const path = `/api/tasks/${task.id}/follow-up`;
  assert.equal(
    (
      await f.request(
        path,
        'POST',
        { message: 'Update description', provider: 'pi' },
        { 'X-Relay-Token': '' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.request(path, 'POST', { message: 'Update description', provider: 'pi' })).status,
    202,
  );
  assert.equal((await f.request(`/api/tasks/${task.id}/resume`, 'POST', {})).status, 409);
  assert.ok((await f.request('/api/health')).data.running >= 1);
  release();
  for (let i = 0; i < 200 && f.app.store.get(task.id).deliveryRuns.at(-1).status === 'running'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const current = f.app.store.get(task.id);
  assert.equal(current.deliveryRuns.at(-1).harness, 'pi');
  assert.equal(current.deliveryRuns.at(-1).status, 'complete');
  assert.equal(current.status, 'completed');
  assert.equal(current.sideQuestions?.length ?? 0, 0);
});
