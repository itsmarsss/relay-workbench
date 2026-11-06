import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicationMonitor, publicationSnapshot } from '../server/publication-monitor.js';
import { publicationPanel, publicationDetails } from '../public/publication.js';
import { runProcess } from '../server/process.js';
import { handoffSchema } from '../server/domain.js';
const snapshot = {
  url: 'https://code.example/team/project/pull/42',
  number: '42',
  title: 'Improve behavior',
  state: 'open',
  draft: true,
  checks: 'pending',
  review: 'required',
};
async function fixture(t, observe) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-publication-'));
  const root = join(directory, 'repo');
  await mkdir(root);
  for (const args of [
    ['init', '-b', 'feature/change'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'test: initial',
    ],
  ]) {
    assert.equal((await runProcess('git', args, { cwd: root })).code, 0);
  }
  const task = {
    id: 'task',
    title: 'A change',
    status: 'completed',
    stage: 'review',
    routing: { investigate: 'codex' },
    attempts: [],
    messages: [],
    repository: { id: 'repo', name: 'Example', instructions: '' },
    workspaceRoot: root,
    workspace: root,
    baseCommit: (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
    branch: 'feature/change',
  };
  let clock = 1000000;
  const events = [];
  const store = {
    directory,
    config: { harnesses: { codex: { enabled: true } } },
    all: () => [structuredClone(task)],
    get: () => structuredClone(task),
    save: (value, event) => {
      Object.assign(task, value);
      if (event) events.push(event);
    },
    event: (_, event) => events.push(event),
  };
  const monitor = new PublicationMonitor(store, { observe, now: () => clock });
  t.after(async () => {
    await monitor.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const settle = async () => {
    await Promise.all([...monitor.running.values()].map((r) => r.done));
  };
  return {
    task,
    monitor,
    root,
    events,
    settle,
    advance: () => {
      clock += 3600000;
      monitor.tick();
    },
  };
}
test('PR monitor discovers status without changing task state and stops at merge', async (t) => {
  let calls = 0;
  const f = await fixture(t, async (input) => {
    assert.equal(input.stage, 'monitor');
    assert.equal(input.config.timeoutMinutes, 2);
    assert.equal(input.task.publicationContext.branch, 'feature/change');
    calls++;
    return {
      verdict: 'complete',
      summary: 'Observed remote PR',
      details: 'Read remote state',
      evidence: ['Provider read completed'],
      publication: { ...snapshot, ...(calls > 1 ? { state: 'merged', checks: 'passing' } : {}) },
    };
  });
  f.monitor.configure('task', 'repo', true);
  f.monitor.tick();
  await f.settle();
  assert.equal(calls, 1);
  assert.equal(f.task.status, 'completed');
  assert.equal(f.task.stage, 'review');
  assert.equal(f.task.publication.url, snapshot.url);
  assert.equal(f.task.publicationMonitor.enabled, true);
  f.advance();
  await f.settle();
  assert.equal(calls, 2);
  assert.equal(f.task.deliveryRuns.length, 2);
  assert.equal(f.task.deliveryRuns[0].handoff.summary, 'Observed remote PR');
  assert.equal(f.task.deliveryRuns[0].status, 'complete');
  assert.notEqual(f.task.deliveryRuns[0].id, f.task.deliveryRuns[1].id);
  assert.equal(f.events.at(-1).attemptId, f.task.deliveryRuns[1].id);
  assert.equal(f.task.publication.state, 'merged');
  assert.equal(f.task.publicationMonitor.enabled, false);
});
test('monitor backs off, retains last snapshot and stops repeated observation failures', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    if (++calls > 1) throw Error('Read access unavailable');
    return {
      verdict: 'complete',
      summary: 'PR found',
      details: 'Observed',
      evidence: ['Remote read'],
      publication: snapshot,
    };
  });
  f.monitor.configure('task', 'repo', true);
  await f.settle();
  for (let n = 0; n < 3; n++) {
    f.advance();
    await f.settle();
  }
  assert.equal(calls, 4);
  assert.equal(f.task.publication.url, snapshot.url);
  assert.equal(f.task.publicationMonitor.enabled, false);
  assert.equal(f.task.status, 'completed');
  assert.match(f.task.publicationMonitor.error, /Read access/);
});
test('monitor rejects unsafe links, missing evidence and source mutation', async (t) => {
  assert.throws(
    () => publicationSnapshot({ ...snapshot, url: 'javascript:alert(1)' }),
    /Invalid PR URL/,
  );
  assert.throws(() => publicationSnapshot({ ...snapshot, url: '' }), /verified URL/);
  let root;
  const f = await fixture(t, async () => {
    await writeFile(join(root, 'unexpected.txt'), 'not allowed');
    return {
      verdict: 'complete',
      summary: 'PR found',
      details: 'Observed',
      evidence: ['Remote read'],
      publication: snapshot,
    };
  });
  root = f.root;
  f.monitor.configure('task', 'repo', true);
  await f.settle();
  assert.equal(f.task.publicationMonitor.enabled, false);
  assert.match(f.task.publicationMonitor.error, /changed the workspace/);
  assert.equal(f.task.publication, undefined);
});
test('Delivery makes acceptance, publication and remote status distinct and escapes output', () => {
  const task = {
    status: 'completed',
    repository: { id: 'repo', name: '<example>', prCommand: {} },
    branch: 'feature',
    submission: { status: 'complete', commit: 'abcdef12345678', stdout: '<script>bad</script>' },
    publication: snapshot,
    publicationMonitor: { enabled: true, status: 'idle' },
  };
  const html = publicationPanel(task);
  assert.match(html, /https:\/\/code.example\/team\/project\/pull\/42/);
  assert.match(publicationDetails(task, 'repo'), /abcdef1234/);
  assert.match(html, /Checks: pending/);
  assert.match(publicationDetails(task, 'repo'), /Pause monitoring/);
  assert.doesNotMatch(
    publicationPanel({ ...task, submission: undefined }),
    /Commit &amp; submit draft PR/,
  );
  assert.doesNotMatch(html, /<script>|<example>/);
  assert.equal(publicationPanel({ ...task, status: 'awaiting_final' }), '');
  assert.equal(publicationPanel({ ...task, status: 'running' }), '');
  const schema = handoffSchema('monitor');
  assert.ok(schema.required.includes('publication'));
});
