import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { DEFAULT_CONFIG, newTask } from '../server/domain.js';
import { git, prepareWorkspace, fingerprint } from '../server/workspace.js';
import { cleanupCandidate, cleanupWorktree } from '../server/lifecycle.js';
import { createBackup, previewBackup, restoreBackup, backupPath } from '../server/backups.js';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-lifecycle-'));
  const store = new Store(join(dir, 'state'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store };
}
async function repository(dir) {
  const path = join(dir, 'repo');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await writeFile(join(path, 'file.txt'), 'before\n');
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
  return {
    id: 'repo',
    name: 'Fixture',
    path,
    cwd: '.',
    strategy: 'worktree',
    setup: [],
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    instructions: '',
  };
}
test('cleanup refuses dirty, active, foreign, attached and unmerged worktrees', async (t) => {
  const { dir, store } = await fixture(t);
  const profile = await repository(dir);
  store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile] });
  const task = newTask({ title: 'Clean up', repositoryId: 'repo' }, store.config);
  await prepareWorkspace(task, store.directory, []);
  store.save(task);
  assert.match((await cleanupCandidate(task, task, store.directory)).reason, /not finished/);
  task.status = 'completed';
  store.save(task);
  const preview = await cleanupCandidate(task, task, store.directory);
  assert.equal(preview.eligible, true);
  await writeFile(join(task.workspaceRoot, 'file.txt'), 'dirty\n');
  await assert.rejects(
    cleanupWorktree(store, { taskId: task.id, repositoryId: 'repo', token: preview.token }),
    /modified/,
  );
  await git(task.workspaceRoot, ['add', '.']);
  await git(task.workspaceRoot, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'test: change',
  ]);
  assert.match((await cleanupCandidate(task, task, store.directory)).reason, /not reachable/);
  await git(profile.path, ['merge', '--ff-only', task.branch]);
  const eligible = await cleanupCandidate(task, task, store.directory);
  assert.equal(eligible.eligible, true);
  const root = task.workspaceRoot;
  await cleanupWorktree(store, { taskId: task.id, repositoryId: 'repo', token: eligible.token });
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  assert.equal(store.get(task.id).workspaceRoot, null);
  assert.ok(await git(profile.path, ['rev-parse', task.branch]));
  assert.equal(
    (
      await cleanupCandidate(
        { ...task, status: 'completed' },
        { ...task, repository: { ...profile, strategy: 'attach' } },
        store.directory,
      )
    ).eligible,
    false,
  );
  assert.match(
    (await cleanupCandidate(task, { ...task, workspaceRoot: profile.path }, store.directory))
      .reason,
    /outside/,
  );
});
test('backup round trip preserves events, image bytes, artifacts and helper modes', async (t) => {
  const { store } = await fixture(t);
  const task = newTask({ title: 'Saved context', demo: true }, DEFAULT_CONFIG);
  task.status = 'awaiting_plan';
  store.save(task, { type: 'decision', summary: 'Review' });
  const paths = [
    'attachments/photo.png',
    `artifacts/${task.id}/attempt/prompt.txt`,
    'local-helper.mjs',
  ];
  for (const name of paths) {
    await mkdir(join(store.directory, name, '..'), { recursive: true });
    await writeFile(
      join(store.directory, name),
      name === 'attachments/photo.png' ? Buffer.from([137, 80, 78, 71, 0, 255]) : 'private context',
      { mode: name.endsWith('.mjs') ? 0o700 : 0o600 },
    );
  }
  store.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('seen:fixture', 'yes');
  const backup = await createBackup(store);
  const bytes = await readFile(backupPath(store.directory, backup.id));
  const preview = await previewBackup(Readable.from([bytes]), store.directory);
  assert.equal(preview.summary.files, 3);
  task.title = 'Changed';
  store.save(task);
  await writeFile(join(store.directory, 'local-helper.mjs'), 'changed');
  await writeFile(join(store.directory, 'extra.txt'), 'extra');
  await restoreBackup(store, preview);
  assert.equal(store.get(task.id).title, 'Saved context');
  assert.equal(store.get(task.id).status, 'interrupted');
  assert.equal(store.events(task.id).length, 1);
  assert.deepEqual(
    await readFile(join(store.directory, 'attachments/photo.png')),
    Buffer.from([137, 80, 78, 71, 0, 255]),
  );
  assert.equal((await lstat(join(store.directory, 'local-helper.mjs'))).mode & 0o777, 0o700);
  await assert.rejects(lstat(join(store.directory, 'extra.txt')), { code: 'ENOENT' });
  assert.equal(
    store.db.prepare('SELECT value FROM meta WHERE key=?').get('seen:fixture').value,
    'yes',
  );
});
test('backup includes portable workspace patches and untracked bytes', async (t) => {
  const { dir, store } = await fixture(t);
  const profile = await repository(dir);
  store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile] });
  const task = newTask({ title: 'Recover code', repositoryId: 'repo' }, store.config);
  await prepareWorkspace(task, store.directory, []);
  task.status = 'paused';
  store.save(task);
  await writeFile(join(task.workspaceRoot, 'file.txt'), 'after \n');
  const before = await fingerprint(task);
  await writeFile(join(task.workspaceRoot, 'file.txt'), 'after  \n');
  assert.notEqual(
    before,
    await fingerprint(task),
    'Trailing whitespace changes must invalidate approval',
  );
  await writeFile(join(task.workspaceRoot, 'new.bin'), Buffer.from([0, 1, 2]));
  const backup = await createBackup(store);
  const preview = await previewBackup(
    Readable.from([await readFile(backupPath(store.directory, backup.id))]),
    store.directory,
  );
  const patch = preview.files.find((p) => p.endsWith('/changes.patch'));
  assert.match(await readFile(join(preview.directory, 'files', patch), 'utf8'), /\+after/);
  await git(profile.path, ['apply', '--check', join(preview.directory, 'files', patch)]);
  assert.ok(
    (await readFile(join(preview.directory, 'files', patch), 'utf8')).includes('+after  \n'),
  );
  const binary = preview.files.find((p) => p.endsWith('/untracked/new.bin'));
  assert.deepEqual(
    await readFile(join(preview.directory, 'files', binary)),
    Buffer.from([0, 1, 2]),
  );
  await rm(preview.directory, { recursive: true, force: true });
});
test('archive validation rejects corruption, traversal, protected files and truncation', async (t) => {
  const { store } = await fixture(t);
  await writeFile(join(store.directory, 'asset.txt'), 'asset');
  const backup = await createBackup(store);
  const data = await readFile(backupPath(store.directory, backup.id));
  const records = gunzipSync(data).toString().trim().split('\n').map(JSON.parse);
  for (const path of [
    '../outside',
    '/absolute',
    'relay.sqlite',
    'server.lock',
    'RELAY.SQLITE',
    'Config.Json',
    'WorkTrees/important',
    'artifacts/../../outside',
  ]) {
    const changed = structuredClone(records);
    changed.find((r) => r.type === 'file').path = path;
    await assert.rejects(
      previewBackup(
        Readable.from([gzipSync(changed.map((r) => JSON.stringify(r)).join('\n') + '\n')]),
        store.directory,
      ),
      /path/,
    );
  }
  const corrupt = structuredClone(records);
  corrupt.find((r) => r.type === 'file').sha256 = 'bad';
  await assert.rejects(
    previewBackup(
      Readable.from([gzipSync(corrupt.map((r) => JSON.stringify(r)).join('\n') + '\n')]),
      store.directory,
    ),
    /checksum/,
  );
  await assert.rejects(
    previewBackup(
      Readable.from([
        gzipSync(
          records
            .slice(0, -1)
            .map((r) => JSON.stringify(r))
            .join('\n') + '\n',
        ),
      ]),
      store.directory,
    ),
    /Truncated/,
  );
  await assert.rejects(previewBackup(Readable.from([Buffer.from('bad gzip')]), store.directory));
  await symlink(join(store.directory, 'asset.txt'), join(store.directory, 'symlink'));
  await assert.rejects(createBackup(store), /symbolic link/);
});
test('restore rollback and startup recovery preserve the previous state', async (t) => {
  const { store } = await fixture(t);
  const task = newTask({ title: 'Original', demo: true }, DEFAULT_CONFIG);
  store.save(task, { type: 'created' });
  await writeFile(join(store.directory, 'asset.txt'), 'original');
  const backup = await createBackup(store),
    preview = await previewBackup(
      Readable.from([await readFile(backupPath(store.directory, backup.id))]),
      store.directory,
    );
  preview.state.meta = [
    { key: 'duplicate', value: '1' },
    { key: 'duplicate', value: '2' },
  ];
  await assert.rejects(restoreBackup(store, preview), /UNIQUE/);
  assert.equal(store.get(task.id).title, 'Original');
  assert.equal(await readFile(join(store.directory, 'asset.txt'), 'utf8'), 'original');
  const recovery = join(store.directory, 'restore-staging', 'crash');
  await mkdir(join(recovery, 'rollback'), { recursive: true });
  await mkdir(join(recovery, 'files'), { recursive: true });
  const old = {
    config: store.config,
    tasks: store.all(),
    events: store.events(task.id).map(({ seq, ...event }) => ({ seq, event })),
    meta: [],
  };
  await writeFile(join(recovery, 'old-state.json'), JSON.stringify(old));
  await rename(join(store.directory, 'asset.txt'), join(recovery, 'rollback', 'asset.txt'));
  await writeFile(join(store.directory, 'asset.txt'), 'partially restored');
  await writeFile(
    join(store.directory, 'restore-journal.json'),
    JSON.stringify({
      directory: recovery,
      oldFiles: ['asset.txt'],
      newFiles: ['asset.txt'],
      phase: 'installing',
    }),
  );
  task.title = 'Partially restored';
  store.save(task);
  store.close();
  const recovered = new Store(store.directory);
  try {
    assert.equal(recovered.get(task.id).title, 'Original');
    assert.equal(await readFile(join(store.directory, 'asset.txt'), 'utf8'), 'original');
  } finally {
    recovered.close();
  }
});
