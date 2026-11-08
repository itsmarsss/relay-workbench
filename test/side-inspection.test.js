import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInspector, inspectionTools } from '../server/side-inspection.js';
import { sideInvocation } from '../server/side-questions.js';
import { runProcess } from '../server/process.js';
const execute = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-inspect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  await mkdir(root);
  const git = async (...args) =>
    (
      await execute('git', ['-C', root, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_COMMITTER_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.test',
          GIT_COMMITTER_EMAIL: 'test@example.test',
        },
      })
    ).stdout;
  await git('init', '-b', 'main');
  await writeFile(join(root, 'source.txt'), 'first line\nordering contract\nthird line\n');
  await git('add', 'source.txt');
  await git('commit', '-m', 'test: ordering contract');
  const repositories = [{ id: 'one', workspace: root }];
  return { root, directory, git, repositories, inspect: createInspector(repositories) };
}
test('side inspection reads live source, history and diffs without changing the worktree', async (t) => {
  const f = await fixture(t);
  const before = await f.git('status', '--porcelain');
  const first = await f.inspect('read_file', {
    repositoryId: 'one',
    path: 'source.txt',
    startLine: 2,
    lines: 1,
  });
  assert.equal(first.content, '2: ordering contract');
  assert.match(first.headBefore, /^[a-f0-9]{40}$/);
  assert.equal(first.revisionChanged, false);
  assert.equal(first.changedDuringRead, false);
  for (const [name, args, pattern] of [
    ['list_files', {}, /source.txt/],
    ['search', { text: 'ordering contract' }, /source.txt:2:ordering contract/],
    ['git_inspect', { operation: 'log', text: 'ordering contract' }, /test: ordering contract/],
    ['git_inspect', { operation: 'blame', path: 'source.txt', lines: 3 }, /ordering contract/],
    [
      'git_inspect',
      { operation: 'show', commit: first.headBefore, path: 'source.txt' },
      /ordering contract/,
    ],
  ])
    assert.match((await f.inspect(name, { repositoryId: 'one', ...args })).output, pattern);
  assert.equal(await f.git('status', '--porcelain'), before);
  await writeFile(join(f.root, 'source.txt'), 'uncommitted new behavior\n');
  const next = await f.inspect('read_file', { repositoryId: 'one', path: 'source.txt' });
  assert.equal(next.headBefore, first.headBefore);
  assert.notEqual(next.contentHash, first.contentHash);
  assert.match(
    (await f.inspect('git_inspect', { repositoryId: 'one', operation: 'diff' })).output,
    /uncommitted new behavior/,
  );
  assert.match(
    (await f.inspect('git_inspect', { repositoryId: 'one', operation: 'status' })).output,
    /source.txt/,
  );
  assert.equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'uncommitted new behavior\n');
});
test('inspection rejects command injection, unavailable repositories and paths leaving the worktree', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'outside.txt'), 'private');
  await symlink(join(f.directory, 'outside.txt'), join(f.root, 'external'));
  await symlink(join(f.root, '.git'), join(f.root, 'git-alias'));
  for (const path of [
    '../outside.txt',
    '/etc/passwd',
    'external',
    '.git/config',
    'git-alias/config',
  ])
    await assert.rejects(f.inspect('read_file', { repositoryId: 'one', path }));
  for (const operation of [
    'push',
    'fetch',
    'checkout',
    'config',
    'reset',
    'commit',
    'diff; touch injected',
  ])
    await assert.rejects(f.inspect('git_inspect', { repositoryId: 'one', operation }));
  await assert.rejects(
    f.inspect('git_inspect', {
      repositoryId: 'one',
      operation: 'show',
      commit: 'HEAD:../../outside.txt',
    }),
  );
  await assert.rejects(f.inspect('read_file', { repositoryId: 'missing', path: 'source.txt' }));
  await assert.rejects(f.inspect('bash', { repositoryId: 'one', command: 'touch injected' }));
  await assert.rejects(
    f.inspect('read_file', { repositoryId: 'one', path: 'source.txt', lines: 301 }),
  );
  assert.equal(
    (await f.inspect('search', { repositoryId: 'one', text: '$(touch injected)' })).output,
    '',
  );
  assert.equal(await f.git('status', '--porcelain', '--', 'injected'), '');
});
test('side agent exposes only the fixed MCP tools and supports snapshot-only tasks', async (t) => {
  const f = await fixture(t);
  const args = sideInvocation({ model: 'fixture-model' }, { repositories: f.repositories });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['relay_source']);
  assert.equal(config.mcpServers.relay_source.command, process.execPath);
  assert.deepEqual(
    args[args.indexOf('--allowedTools') + 1].split(','),
    inspectionTools.map((tool) => `mcp__relay_source__${tool.name}`),
  );
  const absent = sideInvocation({}, { repositories: [{ id: 'draft', workspace: null }] });
  assert.deepEqual(JSON.parse(absent[absent.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { repositoryId: 'one', path: 'source.txt' } },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'touch injected' } },
    },
  ];
  const result = await runProcess(
    process.execPath,
    [
      fileURLToPath(new URL('../server/side-inspection-mcp.js', import.meta.url)),
      JSON.stringify(f.repositories),
    ],
    {
      cwd: f.directory,
      input: calls.map((c) => JSON.stringify(c)).join('\n') + '\n',
      timeout: 20000,
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const responses = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 4);
  assert.equal(responses[1].result.tools.length, inspectionTools.length);
  assert.match(responses[2].result.content[0].text, /ordering contract/);
  assert.equal(responses[3].result.isError, true);
});
