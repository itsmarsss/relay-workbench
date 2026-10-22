import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { DEFAULT_CONFIG, newTask } from '../server/domain.js';
import { git, diff } from '../server/workspace.js';
import { demoHandoff, buildPrompt } from '../server/harness.js';

async function wait(store, id, status) {
  for (let i = 0; i < 2000; i++) {
    const t = store.get(id);
    if (t.status === status) return t;
    if (t.status === 'blocked') throw new Error(t.error);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-multi-'));
  const store = new Store(join(directory, 'state'));
  const repositories = [];
  for (const id of ['service', 'client']) {
    const path = join(directory, id);
    await mkdir(path);
    await git(path, ['init', '-b', 'feature/example']);
    await writeFile(join(path, 'contract.txt'), 'v1');
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
      checks: [
        {
          command: process.execPath,
          args: [
            '-e',
            `const fs=require('fs');const p=JSON.parse(process.env.RELAY_WORKSPACES_JSON);for(const root of Object.values(p))if(fs.readFileSync(root+'/contract.txt','utf8')!=='v2')process.exit(1)`,
          ],
        },
      ],
      setup: [],
      instructions: '',
    });
  }
  store.setConfig({ ...DEFAULT_CONFIG, repositories });
  const calls = [];
  const engine = new Engine(store, {
    harness: async ({ task, stage }) => {
      calls.push([stage, task.activeRepositoryId]);
      if (stage === 'plan') {
        const prompt = buildPrompt(task, stage);
        assert.match(prompt, /service/);
        assert.match(prompt, /client/);
        assert.equal(task.attempts.filter((a) => a.stage === 'investigate').length, 2);
      }
      if (stage === 'implement') await writeFile(join(task.workspace, 'contract.txt'), 'v2');
      await options.harness?.({ task, stage });
      return demoHandoff(task, stage);
    },
  });
  t.after(async () => {
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = engine.create({
    title: 'Upgrade contract',
    repositoryIds: ['client', 'service'],
    dependencies: [{ repositoryId: 'client', dependsOn: 'service' }],
  });
  return { directory, store, engine, task, calls, repositories };
}
async function toFinal(f) {
  await f.engine.action(f.task.id, 'start');
  await wait(f.store, f.task.id, 'awaiting_plan');
  assert.equal(
    f.calls.some((c) => c[0] === 'implement'),
    false,
  );
  await f.engine.action(f.task.id, 'approve-plan', { optionId: 'shared-boundary' });
  return wait(f.store, f.task.id, 'awaiting_final');
}

test('repository dependency graph validates selection and cycles', () => {
  const config = { ...DEFAULT_CONFIG, repositories: [{ id: 'a' }, { id: 'b' }] };
  assert.throws(() => newTask({ title: 'x', repositoryIds: ['a', 'a'] }, config), /Duplicate/);
  assert.throws(() => newTask({ title: 'x', repositoryIds: ['a', 'missing'] }, config), /Unknown/);
  assert.throws(
    () =>
      newTask(
        {
          title: 'x',
          repositoryIds: ['a', 'b'],
          dependencies: [
            { repositoryId: 'a', dependsOn: 'b' },
            { repositoryId: 'b', dependsOn: 'a' },
          ],
        },
        config,
      ),
    /cycle/,
  );
  assert.throws(
    () =>
      newTask(
        { title: 'x', repositoryIds: ['a'], dependencies: [{ repositoryId: 'a', dependsOn: 'b' }] },
        config,
      ),
    /distinct selected/,
  );
});
test('multi-repo workflow shares gates, checks contracts and scopes every review', async (t) => {
  const f = await fixture(t);
  const final = await toFinal(f);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'implement').map((c) => c[1]),
    ['service', 'client'],
  );
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'review').map((c) => c[1]),
    ['service', 'client'],
  );
  assert.equal(final.attempts.find((a) => a.stage === 'verify').handoff.checks.length, 2);
  const changes = await diff(final);
  assert.equal(changes.repositories.length, 2);
  assert.ok(changes.repositories.every((r) => r.text.includes('+v2')));
  await f.engine.action(final.id, 'accept');
  assert.equal(f.store.get(final.id).approvals.length, 2);
  assert.ok(f.store.get(final.id).repositories.every((r) => r.acceptedFingerprint));
  assert.equal(f.engine.workspaceReservations.size, 0);
});
test('edits in any repository invalidate joint final approval', async (t) => {
  const f = await fixture(t);
  const final = await toFinal(f);
  await writeFile(join(final.repositories[1].workspace, 'contract.txt'), 'external');
  await assert.rejects(f.engine.action(final.id, 'accept'), /changed after review/);
});
test('implementation cannot silently edit another participating repository', async (t) => {
  const f = await fixture(t, {
    harness: async ({ task, stage }) => {
      if (stage === 'implement')
        await writeFile(
          join(
            task.repositoryMap.find((r) => r.repository.id !== task.activeRepositoryId).workspace,
            'contract.txt',
          ),
          'outside-scope',
        );
    },
  });
  await f.engine.action(f.task.id, 'start');
  await wait(f.store, f.task.id, 'awaiting_plan');
  await f.engine.action(f.task.id, 'approve-plan', { optionId: 'shared-boundary' });
  for (let i = 0; i < 1000 && f.store.get(f.task.id).status !== 'blocked'; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.match(f.store.get(f.task.id).error, /another repository/);
});
test('restart restores all checkout reservations and explicit stage cursor', async (t) => {
  const f = await fixture(t);
  await f.engine.action(f.task.id, 'start');
  const planned = await wait(f.store, f.task.id, 'awaiting_plan');
  await f.engine.stop();
  planned.status = 'running';
  planned.stage = 'implement';
  planned.repositoryCursor = 1;
  planned.attempts.push({ stage: 'implement', repositoryId: 'client', status: 'running' });
  f.store.save(planned);
  const recovered = new Engine(f.store);
  assert.equal(recovered.workspaceReservations.size, 2);
  assert.equal(f.store.get(planned.id).status, 'interrupted');
  assert.equal(f.store.get(planned.id).repositoryCursor, 1);
  await recovered.action(planned.id, 'cancel');
  assert.equal(recovered.workspaceReservations.size, 0);
});
test('isolated worktrees persist independently and retain a primary alias', async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.store.config);
  config.repositories.forEach((r) => (r.strategy = 'worktree'));
  f.store.setConfig(config);
  const task = f.engine.create({ title: 'Isolated', repositoryIds: ['service', 'client'] });
  await f.engine.action(task.id, 'start');
  const planned = await wait(f.store, task.id, 'awaiting_plan');
  assert.equal(new Set(planned.repositories.map((r) => r.workspace)).size, 2);
  assert.equal(planned.workspace, planned.repositories[0].workspace);
  assert.ok(planned.repositories.every((r) => r.workspace.includes(task.id)));
  await f.engine.action(task.id, 'cancel');
});

test('resuming a failed repository preserves earlier implementation progress', async (t) => {
  let fail = true;
  const f = await fixture(t, {
    harness: async ({ task, stage }) => {
      if (stage === 'implement' && task.activeRepositoryId === 'client' && fail) {
        fail = false;
        throw new Error('Temporary harness failure');
      }
    },
  });
  await f.engine.action(f.task.id, 'start');
  await wait(f.store, f.task.id, 'awaiting_plan');
  await f.engine.action(f.task.id, 'approve-plan', { optionId: 'shared-boundary' });
  for (let i = 0; i < 1000 && f.store.get(f.task.id).status !== 'blocked'; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.match(f.store.get(f.task.id).error, /Temporary/);
  assert.equal(f.store.get(f.task.id).repositoryCursor, 1);
  await f.engine.action(f.task.id, 'resume');
  await wait(f.store, f.task.id, 'awaiting_final');
  assert.equal(f.calls.filter((c) => c[0] === 'implement' && c[1] === 'service').length, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'implement' && c[1] === 'client').length, 2);
});
