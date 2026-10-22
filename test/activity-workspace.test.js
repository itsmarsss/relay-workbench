import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeEvent, executeHarness, demoHandoff } from '../server/harness.js';
import { DEFAULT_CONFIG, newTask, validateConfig } from '../server/domain.js';
import { prepareWorkspace, git } from '../server/workspace.js';

test('adapters retain visible assistant messages and tool evidence', () => {
  const codex = decodeEvent(
    'codex',
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Found the failing request path.' },
    }),
  );
  assert.equal(codex.kind, 'message');
  assert.equal(codex.details, 'Found the failing request path.');
  const tool = decodeEvent(
    'codex',
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'node --test',
        exit_code: 1,
        aggregated_output: 'Failure: expected v2',
      },
    }),
  );
  assert.match(tool.details, /expected v2/);
  const claude = decodeEvent(
    'claude',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Tracing the caller.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'client.js' } },
        ],
      },
    }),
  );
  assert.equal(claude.activities.length, 2);
  assert.equal(claude.activities[0].kind, 'message');
  assert.match(claude.activities[1].details, /client.js/);
  const pi = decodeEvent(
    'pi',
    JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The contract differs.' }] },
    }),
  );
  assert.equal(pi.kind, 'message');
  assert.deepEqual(
    decodeEvent(
      'codex',
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'private' } }),
    ),
    {},
  );
});
test('progress arrives before the subprocess final handoff', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const task = newTask({ title: 'Stream progress', demo: true }, DEFAULT_CONFIG);
  task.workspace = dir;
  const handoff = demoHandoff(task, 'investigate');
  const binary = join(dir, 'harness.js');
  const message = {
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Investigating the parser now.' },
  };
  const final = {
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(handoff) },
  };
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify(message))});setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(final))}),250)});`,
    { mode: 0o700 },
  );
  const config = structuredClone(DEFAULT_CONFIG);
  config.harnesses.codex.command = binary;
  let finished = false,
    live = false;
  const result = await executeHarness({
    task,
    stage: 'investigate',
    harness: 'codex',
    config,
    directory: dir,
    attemptId: 'stream',
    onEvent(event) {
      if (event.type === 'activity' && event.kind === 'message') {
        assert.equal(finished, false);
        assert.match(event.details, /parser/);
        live = true;
      }
    },
  });
  finished = true;
  assert.ok(live);
  assert.equal(result.summary, handoff.summary);
});
test('managed workspace commands create and reuse a verified isolated checkout', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-managed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'source');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await writeFile(join(repo, 'file.txt'), 'source');
  await git(repo, ['add', '.']);
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'test: fixture',
  ]);
  const manager = join(dir, 'manager.mjs');
  await writeFile(
    manager,
    `import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';import {join} from 'node:path';const [name,branch,base]=process.argv.slice(2);const target=join(${JSON.stringify(dir)},name);if(!existsSync(target)){const r=spawnSync('git',['worktree','add','-b',branch,target,base],{stdio:'inherit'});process.exitCode=r.status}`,
  );
  const profile = {
    id: 'fixture',
    name: 'Fixture',
    path: repo,
    strategy: 'managed',
    cwd: '.',
    checks: [],
    workspaceCommand: {
      command: process.execPath,
      args: [manager, '{workspaceName}', '{branch}', '{baseCommit}'],
    },
    workspacePath: join(dir, '{workspaceName}'),
  };
  const config = validateConfig({ repositories: [profile] });
  assert.throws(
    () => validateConfig({ repositories: [{ ...profile, workspaceCommand: null }] }),
    /creation command/,
  );
  const task = newTask({ title: 'Isolate', repositoryId: 'fixture' }, config);
  await prepareWorkspace(task, dir, []);
  assert.notEqual(task.workspaceRoot, repo);
  assert.equal(task.branch, `relay/${task.id}`);
  assert.equal(await git(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  const resumed = { ...task, workspace: null, workspaceRoot: null };
  await prepareWorkspace(resumed, dir, []);
  assert.equal(resumed.workspaceRoot, task.workspaceRoot);
  // An idempotent manager cannot silently return the source checkout.
  await assert.rejects(
    prepareWorkspace(
      { ...task, workspace: null, repository: { ...profile, workspacePath: repo } },
      dir,
      [],
    ),
    /separate checkout/,
  );
});
