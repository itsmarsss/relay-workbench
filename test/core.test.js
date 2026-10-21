import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { DEFAULT_CONFIG, validateConfig, parseHandoff } from '../server/domain.js';
import { buildInvocation, decodeEvent, demoHandoff } from '../server/harness.js';
import { runProcess } from '../server/process.js';
import { git, fingerprint, inspectRepository } from '../server/workspace.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const store = new Store(join(directory, 'state'));
  let engine;
  t.after(async () => { await engine?.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, makeEngine(options) { engine = new Engine(store, options); return engine; } };
}
async function waitFor(store, id, predicate, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const task = store.get(id);
    if (predicate(task)) return task;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Timed out: ${JSON.stringify(store.get(id))}`);
}
async function makeRepo(directory) {
  const repo = join(directory, 'repo'); await mkdir(repo);
  await git(repo, ['init', '-b', 'feature/test']);
  await writeFile(join(repo, 'value.txt'), 'before\n');
  await git(repo, ['add', '.']);
  await runProcess('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'test: fixture']);
  return repo;
}
function profile(path, overrides = {}) { return { id: 'repo', name: 'Fixture', path, cwd: '.', strategy: 'worktree', checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }], setup: [], instructions: '', ...overrides }; }

test('configuration validates routes and explicit argument arrays', () => {
  const config = validateConfig({}); assert.equal(config.routing.implement, 'codex');
  assert.throws(() => validateConfig({ routing: { review: 'unknown' } }), /Unknown harness/);
  assert.throws(() => validateConfig({ concurrency: 0 }), /concurrency/);
  assert.throws(() => validateConfig({ repositories: [profile('/tmp/repo', { checks: ['npm test'] })] }), /Command must/);
  assert.throws(() => validateConfig({ repositories: [profile('/a'), profile('/b')] }), /Duplicate/);
});
test('store persists events and prevents a second owner', async t => {
  const f = await fixture(t); const engine = f.makeEngine({ demoDelay: 1 });
  const task = engine.create({ title: 'Example', demo: true });
  assert.equal(f.store.get(task.id).title, 'Example');
  assert.equal(f.store.events(task.id)[0].type, 'created');
  assert.throws(() => new Store(join(f.directory, 'state')), /already owned/);
});
test('demo workflow pauses at both gates and preserves approvals', async t => {
  const f = await fixture(t); const engine = f.makeEngine({ demoDelay: 1 });
  const task = engine.create({ title: 'Normalize defaults', demo: true });
  await engine.action(task.id, 'start');
  const planned = await waitFor(f.store, task.id, t => t.status === 'awaiting_plan');
  assert.equal(planned.attempts.length, 3);
  await assert.rejects(engine.action(task.id, 'accept'), /not awaiting final/);
  await assert.rejects(engine.action(task.id, 'approve-plan', { optionId: 'missing' }), /Select one/);
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  await waitFor(f.store, task.id, t => t.status === 'awaiting_final');
  await engine.action(task.id, 'accept');
  const done = f.store.get(task.id);
  assert.equal(done.status, 'completed'); assert.equal(done.approvals.length, 2);
});
test('request changes routes back to design or implementation', async t => {
  const f = await fixture(t); const engine = f.makeEngine({ demoDelay: 1 });
  const task = engine.create({ title: 'Example', demo: true });
  await engine.action(task.id, 'start'); await waitFor(f.store, task.id, t => t.status === 'awaiting_plan');
  await engine.action(task.id, 'request-changes', { note: 'Consider API compatibility' });
  const again = await waitFor(f.store, task.id, t => t.status === 'awaiting_plan');
  assert.equal(again.attempts.filter(a => a.stage === 'plan').length, 2);
  assert.equal(again.messages[0].text, 'Consider API compatibility');
});
test('cancellation prevents progression and preserves workspace', async t => {
  const f = await fixture(t); const engine = f.makeEngine({ demoDelay: 1000 });
  const task = engine.create({ title: 'Example', demo: true });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, t => t.stage === 'investigate' && t.status === 'running');
  await engine.action(task.id, 'cancel');
  await engine.stop();
  assert.equal(f.store.get(task.id).status, 'cancelled');
});
test('startup recovery requires explicit resume', async t => {
  const f = await fixture(t);
  const task = new Engine(f.store).create({ title: 'Recover', demo: true });
  task.status = 'running'; task.attempts.push({ status: 'running' }); f.store.save(task);
  f.makeEngine();
  assert.equal(f.store.get(task.id).status, 'interrupted');
  assert.equal(f.store.get(task.id).attempts[0].status, 'interrupted');
});
test('process runner keeps prompt metacharacters literal', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo unsafe); `echo unsafe`']);
  assert.equal(result.stdout, '$(echo unsafe); `echo unsafe`');
});
test('process cancellation waits for termination', async () => {
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise, /cancelled/);
});
test('process timeout and output limits block execution', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 20 }), /timed out/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBytes: 100 }), /output limit/);
});
test('harness invocations preserve models and use explicit permissions', () => {
  const c = buildInvocation('codex', { command: 'codex', model: 'my-model' }, '/tmp/schema', 'implement');
  assert.ok(c.args.includes('workspace-write')); assert.ok(c.args.includes('my-model'));
  assert.ok(buildInvocation('codex', { command: 'codex' }, '/tmp/schema', 'review').args.includes('read-only'));
  assert.ok(buildInvocation('claude', { command: 'claude' }, '/tmp/schema', 'review').args.includes('plan'));
  assert.ok(buildInvocation('pi', { command: 'pi' }, '/tmp/schema', 'review').args.includes('read,grep,find,ls'));
});
test('event decoders extract final handoffs and failures', () => {
  assert.equal(decodeEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } })).final, '{}');
  assert.deepEqual(decodeEvent('claude', JSON.stringify({ type: 'result', structured_output: { summary: 'ok' } })).final, { summary: 'ok' });
  assert.equal(decodeEvent('claude', JSON.stringify({ type: 'result', is_error: true, result: 'denied' })).error, 'denied');
  assert.equal(decodeEvent('pi', JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '{}' }] } })).final, '{}');
  assert.throws(() => parseHandoff('no JSON'), /invalid structured/);
});
test('live pipeline uses one worktree and catches edits after review', async t => {
  const f = await fixture(t); const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo)] });
  const workspaces = new Set();
  const engine = f.makeEngine({ harness: async ({ task, stage }) => {
    workspaces.add(task.workspace);
    if (stage === 'implement') await writeFile(join(task.workspace, 'value.txt'), 'after\n');
    return { ...demoHandoff(task, stage), risks: [] };
  } });
  const task = engine.create({ title: 'Update value', repositoryId: 'repo' });
  await engine.action(task.id, 'start'); await waitFor(f.store, task.id, t => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const final = await waitFor(f.store, task.id, t => t.status === 'awaiting_final' || t.status === 'blocked');
  assert.equal(final.status, 'awaiting_final', final.error);
  assert.equal(workspaces.size, 1); assert.notEqual(final.workspace, repo);
  const before = await fingerprint(final);
  await writeFile(join(final.workspace, 'new.txt'), 'external edit');
  assert.notEqual(await fingerprint(final), before);
  await assert.rejects(engine.action(task.id, 'accept'), /changed after review/);
  await git(repo, ['worktree', 'remove', '--force', final.workspace]);
});
test('read-only stage modifications block progression', async t => {
  const f = await fixture(t); const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
  const engine = f.makeEngine({ harness: async ({ task, stage }) => {
    await writeFile(join(task.workspace, 'value.txt'), 'unauthorized'); return demoHandoff(task, stage);
  } });
  const task = engine.create({ title: 'Inspect', repositoryId: 'repo' }); await engine.action(task.id, 'start');
  const blocked = await waitFor(f.store, task.id, t => t.status === 'blocked');
  assert.match(blocked.error, /modified the workspace/);
});
test('verification failures exhaust the repair budget without acceptance', async t => {
  const f = await fixture(t); const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, maxRepairRounds: 1, repositories: [profile(repo, { strategy: 'attach', checks: [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }] })] });
  const engine = f.makeEngine({ harness: async ({ task, stage }) => demoHandoff(task, stage) });
  const task = engine.create({ title: 'Repair', repositoryId: 'repo' }); await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, t => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const blocked = await waitFor(f.store, task.id, t => t.status === 'blocked');
  assert.match(blocked.error, /Repair limit/); assert.equal(blocked.round, 2);
  assert.equal(blocked.attempts.filter(a => a.stage === 'review').length, 0);
});
test('working directories cannot escape the repository', async t => {
  const f = await fixture(t); const repo = await makeRepo(f.directory);
  await assert.rejects(inspectRepository({ path: repo, cwd: '..' }), /inside the repository/);
});
