import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { DEFAULT_CONFIG, validateConfig, parseHandoff } from '../server/domain.js';
import { buildInvocation, decodeEvent, demoHandoff } from '../server/harness.js';
import { runProcess, executableExists } from '../server/process.js';

const hasTmux = await executableExists('tmux');
import { git, fingerprint, inspectRepository } from '../server/workspace.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const store = new Store(join(directory, 'state'));
  let engine;
  t.after(async () => {
    await engine?.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    makeEngine(options) {
      engine = new Engine(store, options);
      return engine;
    },
  };
}
async function waitFor(store, id, predicate, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const task = store.get(id);
    if (predicate(task)) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out: ${JSON.stringify(store.get(id))}`);
}
async function makeRepo(directory) {
  const repo = join(directory, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'feature/test']);
  await writeFile(join(repo, 'value.txt'), 'before\n');
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
    'test: fixture',
  ]);
  return repo;
}
function profile(path, overrides = {}) {
  return {
    id: 'repo',
    name: 'Fixture',
    path,
    cwd: '.',
    strategy: 'worktree',
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    setup: [],
    instructions: '',
    ...overrides,
  };
}

test('configuration validates routes and explicit argument arrays', () => {
  const config = validateConfig({});
  assert.equal(config.routing.implement, 'codex');
  assert.throws(() => validateConfig({ routing: { review: 'unknown' } }), /Unknown harness/);
  assert.throws(() => validateConfig({ concurrency: 0 }), /concurrency/);
  assert.throws(
    () => validateConfig({ repositories: [profile('/tmp/repo', { checks: ['npm test'] })] }),
    /Command must/,
  );
  assert.throws(
    () => validateConfig({ repositories: [profile('/a'), profile('/b')] }),
    /Duplicate/,
  );
});
test('store persists events and prevents a second owner', async (t) => {
  const f = await fixture(t);
  const engine = f.makeEngine({ demoDelay: 1 });
  const task = engine.create({ title: 'Example', demo: true });
  assert.equal(f.store.get(task.id).title, 'Example');
  assert.equal(f.store.events(task.id)[0].type, 'created');
  assert.throws(() => new Store(join(f.directory, 'state')), /already owned/);
});
test('demo workflow pauses at both gates and preserves approvals', async (t) => {
  const f = await fixture(t);
  const engine = f.makeEngine({ demoDelay: 1 });
  const task = engine.create({ title: 'Normalize defaults', demo: true });
  await engine.action(task.id, 'start');
  const planned = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  assert.equal(planned.attempts.length, 3);
  await assert.rejects(engine.action(task.id, 'accept'), /not awaiting final/);
  await assert.rejects(
    engine.action(task.id, 'approve-plan', { optionId: 'missing' }),
    /Select one/,
  );
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
  await engine.action(task.id, 'accept');
  const done = f.store.get(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.approvals.length, 2);
});
test('request changes routes back to design or implementation', async (t) => {
  const f = await fixture(t);
  const engine = f.makeEngine({ demoDelay: 1 });
  const task = engine.create({ title: 'Example', demo: true });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'request-changes', { note: 'Consider API compatibility' });
  const again = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  assert.equal(again.attempts.filter((a) => a.stage === 'plan').length, 2);
  assert.equal(again.messages[0].text, 'Consider API compatibility');
});
test('cancellation prevents progression and preserves workspace', async (t) => {
  const f = await fixture(t);
  const engine = f.makeEngine({ demoDelay: 1000 });
  const task = engine.create({ title: 'Example', demo: true });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.stage === 'investigate' && t.status === 'running');
  await engine.action(task.id, 'cancel');
  await engine.stop();
  assert.equal(f.store.get(task.id).status, 'cancelled');
});
test('startup recovery requires explicit resume', async (t) => {
  const f = await fixture(t);
  const task = new Engine(f.store).create({ title: 'Recover', demo: true });
  task.status = 'running';
  task.attempts.push({ status: 'running' });
  f.store.save(task);
  f.makeEngine();
  assert.equal(f.store.get(task.id).status, 'interrupted');
  assert.equal(f.store.get(task.id).attempts[0].status, 'interrupted');
});
test('process runner keeps prompt metacharacters literal', async () => {
  const result = await runProcess(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    '$(echo unsafe); `echo unsafe`',
  ]);
  assert.equal(result.stdout, '$(echo unsafe); `echo unsafe`');
});
test('process cancellation waits for termination', async () => {
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise, /cancelled/);
});
test('process timeout and output limits block execution', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 20 }),
    /timed out/,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
      maxBytes: 100,
    }),
    /output limit/,
  );
});
test('harness invocations preserve models and use explicit permissions', () => {
  const c = buildInvocation(
    'codex',
    { command: 'codex', model: 'my-model' },
    '/tmp/schema',
    'implement',
  );
  assert.ok(c.args.includes('workspace-write'));
  assert.ok(c.args.includes('my-model'));
  assert.ok(
    buildInvocation('codex', { command: 'codex' }, '/tmp/schema', 'review').args.includes(
      'read-only',
    ),
  );
  assert.ok(
    buildInvocation('claude', { command: 'claude' }, '/tmp/schema', 'review').args.includes('plan'),
  );
  assert.ok(
    buildInvocation('pi', { command: 'pi' }, '/tmp/schema', 'review').args.includes(
      'read,grep,find,ls',
    ),
  );
});
test('event decoders extract final handoffs and failures', () => {
  assert.equal(
    decodeEvent(
      'codex',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }),
    ).final,
    '{}',
  );
  assert.deepEqual(
    decodeEvent('claude', JSON.stringify({ type: 'result', structured_output: { summary: 'ok' } }))
      .final,
    { summary: 'ok' },
  );
  assert.equal(
    decodeEvent('claude', JSON.stringify({ type: 'result', is_error: true, result: 'denied' }))
      .error,
    'denied',
  );
  assert.equal(
    decodeEvent(
      'pi',
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '{}' }] },
      }),
    ).final,
    '{}',
  );
  assert.throws(() => parseHandoff('no JSON'), /invalid structured/);
});
test('live pipeline applies task settings and catches edits after review', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo)] });
  const workspaces = new Set();
  const engine = f.makeEngine({
    harness: async ({ task, stage, harness, config }) => {
      assert.equal(config.timeoutMinutes, 17);
      assert.equal(config.maxRepairRounds, 4);
      assert.equal(config.harnesses[harness].model, `${stage}-model`);
      workspaces.add(task.workspace);
      if (stage === 'implement') await writeFile(join(task.workspace, 'value.txt'), 'after\n');
      return { ...demoHandoff(task, stage), risks: [] };
    },
  });
  const task = engine.create({
    title: 'Update value',
    repositoryId: 'repo',
    models: Object.fromEntries(
      Object.keys(DEFAULT_CONFIG.routing).map((stage) => [stage, `${stage}-model`]),
    ),
    execution: { timeoutMinutes: 17, maxRepairRounds: 4 },
  });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const final = await waitFor(
    f.store,
    task.id,
    (t) => t.status === 'awaiting_final' || t.status === 'blocked',
  );
  assert.equal(final.status, 'awaiting_final', final.error);
  assert.equal(workspaces.size, 1);
  assert.notEqual(final.workspace, repo);
  const before = await fingerprint(final);
  await writeFile(join(final.workspace, 'new.txt'), 'external edit');
  assert.notEqual(await fingerprint(final), before);
  await assert.rejects(engine.action(task.id, 'accept'), /changed after review/);
  await git(repo, ['worktree', 'remove', '--force', final.workspace]);
});
test('read-only stage modifications block progression', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => {
      await writeFile(join(task.workspace, 'value.txt'), 'unauthorized');
      return demoHandoff(task, stage);
    },
  });
  const task = engine.create({ title: 'Inspect', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  const blocked = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.match(blocked.error, /modified the workspace/);
});
test('verification failures exhaust the repair budget without acceptance', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({
    ...DEFAULT_CONFIG,
    maxRepairRounds: 1,
    repositories: [
      profile(repo, {
        strategy: 'attach',
        checks: [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }],
      }),
    ],
  });
  const engine = f.makeEngine({ harness: async ({ task, stage }) => demoHandoff(task, stage) });
  const task = engine.create({ title: 'Repair', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const blocked = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.match(blocked.error, /Repair limit/);
  assert.equal(blocked.round, 2);
  assert.equal(blocked.attempts.filter((a) => a.stage === 'review').length, 0);
});
test('working directories cannot escape the repository', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  await assert.rejects(inspectRepository({ path: repo, cwd: '..' }), /inside the repository/);
});

test('aliased attached profiles reserve the same physical checkout', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  const alias = join(repo, 'subdir');
  await mkdir(alias);
  const a = profile(repo, { strategy: 'attach' });
  const b = profile(alias, { id: 'other-profile', strategy: 'attach' });
  f.store.setConfig({ ...DEFAULT_CONFIG, concurrency: 2, repositories: [a, b] });
  let active = 0,
    highest = 0;
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => {
      active++;
      highest = Math.max(active, highest);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return demoHandoff(task, stage);
    },
  });
  const first = engine.create({ title: 'First', repositoryId: 'repo' });
  const second = engine.create({ title: 'Second', repositoryId: 'other-profile' });
  await engine.action(first.id, 'start');
  await engine.action(second.id, 'start');
  const blocked = await waitFor(f.store, second.id, (t) => t.status === 'blocked');
  assert.match(blocked.error, /reserved/);
  await waitFor(f.store, first.id, (t) => t.status === 'awaiting_plan');
  assert.equal(highest, 1);
  await engine.action(first.id, 'cancel');
  await engine.action(second.id, 'resume');
  await waitFor(f.store, second.id, (t) => t.status === 'awaiting_plan');
});

test('a failed workspace reservation is released when cancelled', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  await writeFile(join(repo, 'value.txt'), 'dirty');
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
  const engine = f.makeEngine({ harness: async ({ task, stage }) => demoHandoff(task, stage) });
  const task = engine.create({ title: 'Dirty checkout', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.equal(engine.workspaceReservations.size, 1);
  await engine.action(task.id, 'cancel');
  assert.equal(engine.workspaceReservations.size, 0);
});

test(
  'manual control preserves approval and reruns checks before final review',
  { skip: !hasTmux },
  async (t) => {
    const f = await fixture(t);
    const repo = await makeRepo(f.directory);
    f.store.setConfig({
      ...f.store.config,
      repositories: [profile(repo, { strategy: 'attach' })],
      harnesses: Object.fromEntries(
        Object.entries(f.store.config.harnesses).map(([id, h]) => [
          id,
          { ...h, enabled: true, command: process.execPath },
        ]),
      ),
    });
    let engine;
    const stages = [];
    engine = f.makeEngine({
      harness: async ({ task, stage }) => {
        stages.push(stage);
        return demoHandoff(task, stage);
      },
    });
    const task = engine.create({ title: 'Manual handoff', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    await engine.action(task.id, 'takeover');
    await waitFor(f.store, task.id, (t) => t.manual?.active);
    await assert.rejects(
      engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' }),
      /not awaiting/,
    );
    await assert.rejects(engine.action(task.id, 'resume'), /cannot start/);
    const manual = f.store.get(task.id).manual;
    await runProcess('tmux', [
      '-S',
      manual.socket,
      'send-keys',
      '-t',
      manual.session,
      '-l',
      'exit',
    ]);
    await runProcess('tmux', ['-S', manual.socket, 'send-keys', '-t', manual.session, 'Enter']);
    await waitFor(f.store, task.id, (t) => !t.manual?.active);
    assert.equal(f.store.get(task.id).status, 'manual');
    assert.equal(f.store.get(task.id).manual.result.code, 0);
    await engine.action(task.id, 'takeover');
    await waitFor(f.store, task.id, (t) => t.manual?.active);
    assert.equal(f.store.get(task.id).approvals.length, 0);
    await engine.action(task.id, 'return-control');
    let planned = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    assert.equal(stages.filter((s) => s === 'investigate').length, 2);
    await engine.action(task.id, 'approve-plan', {
      optionId: planned.attempts.findLast((a) => a.stage === 'plan').handoff.options[0].id,
    });
    await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
    const before = f.store.get(task.id).attempts.filter((a) => a.stage === 'verify').length;
    await engine.action(task.id, 'takeover');
    await waitFor(f.store, task.id, (t) => t.manual?.active);
    await writeFile(join(repo, 'manual.txt'), 'Manual code change\n');
    await assert.rejects(engine.action(task.id, 'accept'), /not awaiting/);
    await engine.action(task.id, 'return-control');
    const reviewed = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
    assert.equal(reviewed.attempts.filter((a) => a.stage === 'verify').length, before + 1);
    assert.equal(reviewed.approvals.filter((a) => a.type === 'approach').length, 1);
    await engine.action(task.id, 'accept');
    assert.equal(f.store.get(task.id).status, 'completed');
  },
);

test('startup interrupts manual control and restores checkout reservation', async (t) => {
  const f = await fixture(t);
  const engine = f.makeEngine();
  const task = engine.create({ title: 'Manual recovery', demo: true });
  task.demo = false;
  task.repository.strategy = 'attach';
  task.workspaceRoot = '/tmp/relay-manual-recovery';
  task.workspace = task.workspaceRoot;
  task.stage = 'verify';
  task.status = 'manual';
  task.manual = { active: true };
  f.store.save(task);
  const recovered = f.makeEngine();
  assert.equal(f.store.get(task.id).status, 'interrupted');
  assert.equal(f.store.get(task.id).manual.active, false);
  assert.equal(recovered.workspaceReservations.get(task.workspaceRoot), task.id);
  await assert.rejects(recovered.action(task.id, 'resume'), /Wait a few seconds/);
});

test(
  'takeover waits for an active writer before opening the manual shell',
  { skip: !hasTmux },
  async (t) => {
    const f = await fixture(t);
    const repo = await makeRepo(f.directory);
    f.store.setConfig({
      ...f.store.config,
      repositories: [profile(repo, { strategy: 'attach' })],
      harnesses: Object.fromEntries(
        Object.entries(f.store.config.harnesses).map(([id, h]) => [
          id,
          { ...h, command: process.execPath, enabled: true },
        ]),
      ),
    });
    let writing = false,
      stopped = false;
    const engine = f.makeEngine({
      harness: async ({ task, stage, signal }) => {
        if (stage === 'implement') {
          writing = true;
          await new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () =>
                setTimeout(() => {
                  stopped = true;
                  resolve();
                }, 150),
              { once: true },
            ),
          );
        }
        return demoHandoff(task, stage);
      },
    });
    const task = engine.create({ title: 'Stop active writer', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    const planned = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    await engine.action(task.id, 'approve-plan', {
      optionId: planned.attempts.findLast((a) => a.stage === 'plan').handoff.options[0].id,
    });
    await waitFor(f.store, task.id, () => writing);
    await engine.action(task.id, 'takeover');
    assert.equal(stopped, true);
    assert.equal(engine.running.has(task.id), false);
    await waitFor(f.store, task.id, (t) => t.manual?.active);
    assert.equal(
      f.store.get(task.id).attempts.findLast((a) => a.stage === 'implement').status,
      'interrupted',
    );
    await engine.action(task.id, 'cancel');
    assert.equal(engine.manualRuns.size, 0);
    assert.equal(engine.workspaceReservations.size, 0);
  },
);

for (const resolves of [true, false])
  test(`agent blockers ${resolves ? 'recover automatically' : 'stop at the recovery limit'}`, async (t) => {
    const f = await fixture(t);
    const repo = await makeRepo(f.directory);
    f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
    let investigations = 0;
    const stages = [];
    const engine = f.makeEngine({
      harness: async ({ task, stage, harness, sessionId, onSession }) => {
        stages.push(stage);
        if (stage === 'investigate') {
          assert.equal(sessionId, undefined, 'Blocked diagnoses must start fresh');
          assert.equal(
            harness,
            task.debugContext && task.recovery.attempts > 1 ? 'claude' : 'codex',
          );
          onSession(`diagnosis-${investigations}`);
        }
        const handoff = demoHandoff(task, stage);
        if (stage === 'investigate') {
          investigations++;
          assert.equal(task.activeRepositoryId, 'repo');
          if (task.debugContext) assert.equal(task.recovery.active, true);
          if (!resolves || investigations === 1)
            return {
              ...handoff,
              verdict: 'blocked',
              summary: 'Local test dependencies are missing',
            };
        }
        return handoff;
      },
    });
    const task = engine.create({ title: 'Recover prerequisites', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    const result = await waitFor(f.store, task.id, (task) =>
      ['awaiting_plan', 'blocked'].includes(task.status),
    );
    assert.equal(result.status, resolves ? 'awaiting_plan' : 'blocked');
    assert.equal(investigations, 3);
    assert.equal(result.attempts.filter((a) => a.role === 'debug').length, resolves ? 1 : 2);
    assert.ok(!stages.includes('implement'));
    assert.equal(result.routing.investigate, 'codex');
    assert.equal(result.recovery.active, false);
    assert.equal(result.recovery.exhausted, !resolves);
    assert.ok(f.store.events(task.id).some((event) => event.type === 'recovery'));
  });

test('debugger escalation carries decisions and replan requires fresh approval', async (t) => {
  const f = await fixture(t),
    repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => {
      const handoff = demoHandoff(task, stage);
      if (task.debugContext || stage === 'implement')
        return {
          ...handoff,
          verdict: 'blocked',
          summary: 'Runtime cannot import fixture identity',
          details: 'Test failed; source remains unchanged.',
          evidence: ['Isolated test returned a keychain error'],
          risks: ['Choose a supported runtime or revise the approach.'],
          options: [
            {
              id: 'runtime',
              title: 'Use a supported runtime',
              description: 'Run the documented check where fixture imports work.',
              tradeoffs: 'Requires runtime access; keeps the approved fix.',
            },
          ],
        };
      return handoff;
    },
  });
  const task = engine.create({ title: 'Debug a runtime failure', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const blocked = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.equal(blocked.stage, 'implement');
  assert.equal(blocked.blockerDecision.debugAttempts, 2);
  assert.equal(blocked.approvals.length, 1);
  await assert.rejects(
    engine.action(task.id, 'resolve-blocker', { decisionId: 'stale', resolution: 'replan' }),
    /changed/,
  );
  await assert.rejects(
    engine.action(task.id, 'resolve-blocker', {
      decisionId: blocked.blockerDecision.id,
      resolution: 'retry',
      optionId: 'unknown',
    }),
    /current debugging option/,
  );
  await engine.action(task.id, 'resolve-blocker', {
    decisionId: blocked.blockerDecision.id,
    resolution: 'replan',
    optionId: 'runtime',
  });
  const replanned = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  assert.equal(replanned.chosenApproach, null);
  assert.equal(replanned.approvals.length, 1);
  assert.match(replanned.messages.at(-1).text, /supported runtime/);
  assert.equal(replanned.attempts.filter((a) => a.stage === 'verify').length, 0);
});

test('debugger cannot change source or advance a blocked investigation', async (t) => {
  const f = await fixture(t),
    repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => {
      const handoff = demoHandoff(task, stage);
      if (task.debugContext) {
        await writeFile(join(repo, 'value.txt'), 'Unexpected debug source edit');
        return handoff;
      }
      if (stage === 'investigate')
        return { ...handoff, verdict: 'blocked', summary: 'Missing prerequisite' };
      return handoff;
    },
  });
  const task = engine.create({ title: 'Read-only debug', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  const blocked = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.match(blocked.error, /modified the workspace/);
  assert.equal(blocked.stage, 'investigate');
  assert.equal(blocked.attempts.filter((a) => a.stage === 'plan').length, 0);
});

test('process failures run a debugger before retrying the original stage', async (t) => {
  const f = await fixture(t),
    repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
  let first = true,
    diagnosed = false;
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => {
      if (stage === 'investigate' && first) {
        first = false;
        throw new Error('Transient tool connection failed');
      }
      if (task.debugContext) {
        diagnosed = true;
        assert.equal(stage, 'investigate');
        assert.match(task.debugContext.reason, /connection failed/);
      }
      return demoHandoff(task, stage);
    },
  });
  const task = engine.create({ title: 'Recover a process error', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  const result = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  assert.equal(diagnosed, true);
  assert.equal(result.attempts.filter((a) => a.role === 'debug').length, 1);
  assert.equal(result.approvals.length, 0);
});
