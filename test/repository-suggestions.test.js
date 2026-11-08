import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../server/workspace.js';
import { repositorySuggestions } from '../server/repository-suggestions.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-profile-'));
  const root = join(directory, 'repo');
  await mkdir(root);
  await git(root, ['init']);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root };
}
test('profile suggestions inspect manifests without executing scripts', async (t) => {
  const { root } = await fixture(t);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'example-service',
      packageManager: 'pnpm@10.0.0',
      scripts: { test: 'touch never-execute', lint: 'example-lint', deploy: 'never-run' },
    }),
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  await writeFile(join(root, 'AGENTS.md'), 'Read local guidance');
  await mkdir(join(root, 'packages/api'), { recursive: true });
  await writeFile(join(root, 'packages/api/package.json'), '{}');
  const report = await repositorySuggestions({ path: root, cwd: '.' });
  assert.equal(report.suggestions.find((s) => s.field === 'name').value, 'example-service');
  assert.deepEqual(
    report.suggestions.filter((s) => s.field === 'checks').map((s) => s.value),
    [
      { command: 'pnpm', args: ['run', 'test'] },
      { command: 'pnpm', args: ['run', 'lint'] },
    ],
  );
  assert.deepEqual(report.suggestions.find((s) => s.field === 'setup').value, {
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
  });
  assert.ok(report.suggestions.some((s) => s.field === 'cwd' && s.value === 'packages/api'));
  assert.deepEqual(report.guidance, ['AGENTS.md']);
  await assert.rejects(access(join(root, 'never-execute')));
  const child = await repositorySuggestions({ path: join(root, 'packages/api'), cwd: '.' });
  assert.equal(child.cwd, 'packages/api');
  assert.ok(child.suggestions.some((s) => s.field === 'path' && s.value === report.root));
  assert.equal(
    child.suggestions.some((s) => s.field === 'setup'),
    false,
    'root install command is not suggested in a nested package',
  );
});
test('profile suggestions tolerate malformed and oversized manifests and skip outside symlinks', async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(root, 'package.json'), '{invalid');
  assert.equal(
    (await repositorySuggestions({ path: root, cwd: '.' })).suggestions[0].value,
    'repo',
  );
  await writeFile(join(root, 'package.json'), ' '.repeat(262145));
  assert.equal(
    (await repositorySuggestions({ path: root, cwd: '.' })).suggestions.some(
      (s) => s.field === 'checks',
    ),
    false,
  );
  await rm(join(root, 'package.json'));
  await writeFile(
    join(directory, 'outside.json'),
    JSON.stringify({ name: 'outside-private', scripts: { test: 'never' } }),
  );
  await symlink(join(directory, 'outside.json'), join(root, 'package.json'));
  const report = await repositorySuggestions({ path: root, cwd: '.' });
  assert.equal(report.suggestions[0].value, 'repo');
  await assert.rejects(repositorySuggestions({ path: root, cwd: '..' }), /inside/);
});
