import { checkpoints } from '../server/workflow-checkpoints.js';
import { runCheck } from '../server/check-runner.js';
import { RuntimeBudgetError } from '../server/runtime-budget.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { DEFAULT_CONFIG, validateConfig, parseHandoff } from '../server/domain.js';
import { buildInvocation, decodeEvent, demoHandoff } from '../server/harness.js';
import { runProcess, executableExists } from '../server/process.js';

const hasTmux = await executableExists('tmux');
import { git, fingerprint, inspectRepository, diff } from '../server/workspace.js';

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
    verificationMode: 'commands',
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
  assert.ok(c.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(c.args.includes('my-model'));
  assert.ok(
    buildInvocation('codex', { command: 'codex' }, '/tmp/schema', 'review').args.includes(
      '--dangerously-bypass-approvals-and-sandbox',
    ),
  );
  assert.ok(
    buildInvocation('claude', { command: 'claude' }, '/tmp/schema', 'review').args.includes(
      'bypassPermissions',
    ),
  );
  assert.ok(
    buildInvocation('pi', { command: 'pi' }, '/tmp/schema', 'review').args.includes(
      'read,bash,edit,write,grep,find,ls',
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
        verificationMode: 'commands',
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
          if (task.continuationContext) assert.equal(sessionId, 'diagnosis-0');
          else assert.equal(sessionId, undefined, 'Blocked diagnoses must start fresh');
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
          if (task.debugContext) {
            assert.equal(task.recovery.active, true);
            assert.equal(task.debugContext.executionAccess, 'host');
            assert.equal(task.debugContext.capabilities.elevated, true);
          }
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
  await waitFor(f.store, task.id, () => !engine.running.has(task.id));
  assert.ok(
    checkpoints(f.store, task.id).some((point) => point.role === 'debug' && point.canChooseDebug),
  );
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

for (const unresolved of [false, true])
  test(`current specialist recovers before debugger escalation: ${unresolved ? 'unresolved' : 'resolved'}`, async (t) => {
    const f = await fixture(t),
      repo = await makeRepo(f.directory);
    f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
    let calls = 0,
      diagnoses = 0;
    const engine = f.makeEngine({
      harness: async ({ task, stage, sessionId, onSession }) => {
        if (task.debugContext) {
          diagnoses++;
          return demoHandoff(task, stage);
        }
        if (stage === 'investigate') {
          calls++;
          if (calls === 2) {
            assert.equal(sessionId, 'original-specialist');
            assert.match(task.continuationContext.interruption, /Temporary connection/);
          }
          onSession('original-specialist');
          if (calls === 1 || (unresolved && calls === 2))
            throw new Error('Temporary connection failure');
        }
        return demoHandoff(task, stage);
      },
    });
    const task = engine.create({ title: 'Recover in the current agent', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    const result = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    assert.equal(diagnoses, unresolved ? 1 : 0);
    assert.equal(calls, unresolved ? 3 : 2);
    assert.equal(result.approvals.length, 0);
  });

test('debugger continues the original implementation conversation and preserves completed edits', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
  let implementations = 0;
  const engine = f.makeEngine({
    harness: async ({ task, stage, sessionId, onSession }) => {
      const handoff = demoHandoff(task, stage);
      if (task.debugContext) return handoff;
      if (stage === 'implement') {
        implementations++;
        if (implementations === 1) {
          onSession('original-implementation');
          await writeFile(join(repo, 'value.txt'), 'completed edit');
          return {
            ...handoff,
            verdict: 'blocked',
            summary: 'Only the remaining check needs retry',
            details: 'Implementation finished; verification tool unavailable',
            files: ['value.txt'],
          };
        }
        assert.equal(sessionId, 'original-implementation');
        assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'completed edit');
        assert.match(task.continuationContext.completedWork.details, /Implementation finished/);
        assert.ok(task.continuationContext.diagnosis);
      }
      return handoff;
    },
  });
  const task = engine.create({ title: 'Continue implementation', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const result = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
  assert.equal(implementations, 2);
  assert.equal(result.approvals.length, 1);
  assert.ok(result.verifiedFingerprint);
});

for (const invalidate of [false, true])
  test(`verification recovery ${invalidate ? 'invalidates stale results' : 'preserves passing checks'}`, async (t) => {
    const f = await fixture(t);
    const repo = await makeRepo(f.directory);
    const count = join(f.directory, 'check-count');
    const missing = join(f.directory, 'restored-check');
    f.store.setConfig({
      ...DEFAULT_CONFIG,
      repositories: [
        profile(repo, {
          strategy: 'attach',
          verificationMode: 'commands',
          checks: [
            {
              command: process.execPath,
              args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(count)}, 'x')`],
            },
            { command: missing, args: [] },
          ],
        }),
      ],
    });
    let diagnoses = 0;
    const engine = f.makeEngine({
      harness: async ({ task, stage }) => {
        if (task.debugContext) {
          diagnoses++;
          assert.equal(task.debugContext.blockedStage, 'verify');
          await writeFile(missing, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
          if (invalidate) {
            const current = f.store.get(task.id);
            current.verificationCheckpoint.fingerprint = 'stale';
            f.store.save(current);
          }
        }
        return demoHandoff(task, stage);
      },
    });
    const task = engine.create({ title: 'Continue verification', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
    const result = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
    assert.equal(diagnoses, 1);
    assert.equal(await readFile(count, 'utf8'), invalidate ? 'xx' : 'x');
    assert.equal(result.attempts.filter((a) => a.stage === 'implement').length, 1);
    const verify = result.attempts.findLast((a) => a.stage === 'verify' && a.role !== 'debug');
    assert.equal(!!verify.handoff.checks[0].reusedFromAttemptId, !invalidate);
    assert.equal(verify.handoff.checks[1].code, 0);
    assert.ok(result.verifiedFingerprint);
  });

for (const exitCode of [0, 1])
  test(`trusted verifier returns real exit ${exitCode} to interrupted implementation`, async (t) => {
    const f = await fixture(t);
    const repo = await makeRepo(f.directory);
    f.store.setConfig({
      ...DEFAULT_CONFIG,
      maxRecoveryAttempts: 0,
      repositories: [
        profile(repo, {
          strategy: 'attach',
          verificationMode: 'commands',
          checks: [
            {
              command: process.execPath,
              args: ['-e', `console.log("host evidence");process.exit(${exitCode})`],
            },
          ],
        }),
      ],
    });
    let continued = false;
    const engine = f.makeEngine({
      harness: async ({ task, stage }) => {
        if (stage === 'implement') {
          if (task.continuationContext?.diagnosis?.checks) {
            continued = true;
            assert.ok(
              task.messages.some(
                (m) => m.text === 'Preserve this direction' && m.delivery === 'pending',
              ),
            );
            assert.equal(task.continuationContext.diagnosis.checks[0].code, exitCode);
            assert.match(task.continuationContext.diagnosis.checks[0].stdout, /host evidence/);
          }
          return {
            ...demoHandoff(task, stage),
            verdict: 'blocked',
            summary: continued ? 'Evidence received' : 'Sandbox-sensitive check',
          };
        }
        return demoHandoff(task, stage);
      },
    });
    const task = engine.create({ title: 'Host verifier', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    await assert.rejects(engine.action(task.id, 'verify-blocker'), /blocked, idle/);
    await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
    await waitFor(f.store, task.id, (t) => t.status === 'blocked' && !engine.running.has(t.id));
    await engine.action(task.id, 'message', { message: 'Preserve this direction' });
    await engine.action(task.id, 'verify-blocker', { command: 'untrusted-command' });
    const result = await waitFor(f.store, task.id, (t) => continued && t.status === 'blocked');
    assert.equal(result.stage, 'implement');
    assert.equal(result.approvals.length, 1);
    assert.equal(result.attempts.filter((a) => a.role === 'verifier').length, 1);
    assert.equal(
      result.attempts.some((a) => a.stage === 'review'),
      false,
    );
    assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'before\n');
  });

for (const disposition of ['repair_requested', 'verification_requested'])
  test(`debugger automatically hands off ${disposition} and preserves the writer`, async (t) => {
    const f = await fixture(t);
    const repo = await makeRepo(f.directory);
    f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo, { strategy: 'attach' })] });
    let resumed = false;
    const engine = f.makeEngine({
      harness: async ({ task, stage, sessionId, onSession }) => {
        if (task.debugContext)
          return {
            ...demoHandoff(task, stage),
            verdict: disposition,
            summary: 'Use configured recovery',
            details: 'Repair the failed prerequisite; preserve approved behavior.',
          };
        if (stage === 'implement') {
          if (!task.continuationContext) {
            onSession('original-writer');
            return {
              ...demoHandoff(task, stage),
              verdict: 'blocked',
              summary: 'Required check needs recovery',
            };
          }
          assert.equal(sessionId, 'original-writer');
          resumed = true;
          if (disposition === 'repair_requested') {
            assert.equal(task.continuationContext.diagnosis.disposition, disposition);
            await writeFile(join(task.workspace, 'value.txt'), 'repaired\n');
          } else assert.equal(task.continuationContext.diagnosis.checks[0].code, 0);
        }
        return demoHandoff(task, stage);
      },
    });
    const task = engine.create({ title: 'Automatic recovery', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
    const result = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
    assert.equal(resumed, true);
    assert.equal(result.approvals.length, 1);
    assert.equal(result.attempts.filter((a) => a.role === 'debug').length, 1);
    assert.equal(
      result.attempts.filter((a) => a.role === 'verifier').length,
      disposition === 'verification_requested' ? 1 : 0,
    );
    assert.ok(result.verifiedFingerprint);
    assert.equal(
      await readFile(join(repo, 'value.txt'), 'utf8'),
      disposition === 'repair_requested' ? 'repaired\n' : 'before\n',
    );
  });

test('automatic repair handoffs remain bounded when the writer cannot fix the failure', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({
    ...DEFAULT_CONFIG,
    maxRecoveryAttempts: 2,
    repositories: [profile(repo, { strategy: 'attach' })],
  });
  const engine = f.makeEngine({
    harness: async ({ task, stage }) =>
      task.debugContext
        ? {
            ...demoHandoff(task, stage),
            verdict: 'repair_requested',
            summary: 'Targeted correction needed',
          }
        : stage === 'implement'
          ? { ...demoHandoff(task, stage), verdict: 'blocked', summary: 'Still failing' }
          : demoHandoff(task, stage),
  });
  const task = engine.create({ title: 'Bounded repair', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const result = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.equal(result.attempts.filter((a) => a.role === 'debug').length, 2);
  assert.equal(
    result.attempts.some((a) => a.stage === 'review'),
    false,
  );
});

test('recovery requests cannot grant host execution before implementation approval', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  const marker = join(f.directory, 'unexpected-check');
  f.store.setConfig({
    ...DEFAULT_CONFIG,
    maxRecoveryAttempts: 0,
    repositories: [
      profile(repo, {
        strategy: 'attach',
        verificationMode: 'commands',
        checks: [
          {
            command: process.execPath,
            args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          },
        ],
      }),
    ],
  });
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => ({
      ...demoHandoff(task, stage),
      verdict: 'verification_requested',
    }),
  });
  const task = engine.create({ title: 'No approval', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  const result = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.equal(result.approvals.length, 0);
  assert.equal(
    result.attempts.some((a) => a.role === 'verifier'),
    false,
  );
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('implementation requests host verification directly through the real handoff validator', async (t) => {
  const { validateHandoff } = await import('../server/domain.js');
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  const count = join(f.directory, 'direct-check-count');
  f.store.setConfig({
    ...DEFAULT_CONFIG,
    repositories: [
      profile(repo, {
        strategy: 'attach',
        verificationMode: 'commands',
        checks: [
          {
            command: process.execPath,
            args: ['-e', `require('fs').appendFileSync(${JSON.stringify(count)}, 'x')`],
          },
        ],
      }),
    ],
  });
  const engine = f.makeEngine({
    harness: async ({ task, stage, sessionId, onSession }) => {
      assert.equal(task.debugContext, undefined);
      const h = demoHandoff(task, stage);
      if (stage === 'implement' && !task.continuationContext) {
        onSession('direct-writer');
        return validateHandoff({ ...h, verdict: 'verification_requested' }, stage);
      }
      if (stage === 'implement') {
        assert.equal(sessionId, 'direct-writer');
        assert.equal(task.continuationContext.diagnosis.checks[0].code, 0);
      }
      return validateHandoff(h, stage);
    },
  });
  const task = engine.create({ title: 'Direct host checks', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const result = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
  assert.equal(
    result.attempts.some((a) => a.role === 'debug'),
    false,
  );
  assert.equal(result.attempts.filter((a) => a.role === 'verifier').length, 1);
  assert.equal(
    await readFile(count, 'utf8'),
    'x',
    'Normal verification reuses the passing check for identical source and command configuration',
  );
  assert.ok(result.verifiedFingerprint);
});

test('repeated direct verification requests reuse evidence and stop without an infinite loop', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  const count = join(f.directory, 'repeated-check-count');
  f.store.setConfig({
    ...DEFAULT_CONFIG,
    maxRecoveryAttempts: 0,
    repositories: [
      profile(repo, {
        strategy: 'attach',
        verificationMode: 'commands',
        checks: [
          {
            command: process.execPath,
            args: ['-e', `require('fs').appendFileSync(${JSON.stringify(count)}, 'x')`],
          },
        ],
      }),
    ],
  });
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => ({
      ...demoHandoff(task, stage),
      ...(stage === 'implement' ? { verdict: 'verification_requested' } : {}),
    }),
  });
  const task = engine.create({ title: 'Bound duplicate requests', repositoryId: 'repo' });
  await engine.action(task.id, 'start');
  await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const result = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.equal(await readFile(count, 'utf8'), 'x');
  assert.equal(result.attempts.filter((a) => a.role === 'verifier').length, 3);
  assert.match(result.error, /already been returned/);
});

for (const failure of [
  null,
  'missing-evidence',
  'failed-check',
  'check-recovery',
  'source-edit',
  'repair-round',
  'no-command-profile',
  'report-correction',
  'report-correction-exhausted',
  'runtime-budget',
])
  test(`agent verification discovers checks and protects its gate: ${failure ?? 'pass'}`, async (t) => {
    const f = await fixture(t);
    const repo = await makeRepo(f.directory);
    const marker = join(f.directory, 'legacy-runner-must-not-run');
    f.store.setConfig({
      ...DEFAULT_CONFIG,
      maxRecoveryAttempts: 0,
      repositories: [
        profile(repo, {
          verificationMode: 'agent',
          strategy: 'attach',
          checks: [
            {
              command: process.execPath,
              args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'wrong')`],
            },
          ],
        }),
      ],
    });
    let verified = false;
    let verificationRuns = 0;
    let executedChecks = 0;
    const engine = f.makeEngine({
      harness: async ({ task, stage, onEvent, onSession, sessionId }) => {
        const h = demoHandoff(task, stage);
        if (stage === 'implement') await writeFile(join(task.workspace, 'value.txt'), 'after\n');
        if (stage === 'verify') {
          verificationRuns++;
          verified = true;
          if (failure === 'repair-round' && verificationRuns === 1)
            return {
              ...h,
              verdict: 'changes_requested',
              summary: 'Repair the source contract before verification',
            };
          assert.equal(task.verificationContext.executionAccess, 'host');
          assert.equal(task.repository.checks.length, 0);
          assert.ok(task.repositoryMap.every((entry) => entry.repository.checks.length === 0));
          const args =
            failure === 'check-recovery' && verificationRuns === 1
              ? ['-e', 'process.exit(1)']
              : [
                  '-e',
                  "if(require('fs').readFileSync('value.txt','utf8')!=='after\\n')process.exit(1)",
                ];
          const preserve =
            (failure?.startsWith('report-correction') || failure === 'runtime-budget') &&
            verificationRuns > 1;
          const prior = preserve
            ? task.verificationContext.priorEvidence.find((p) => p.checks.some((c) => c.code === 0))
            : null;
          const result = prior
            ? prior.checks.find((c) => c.code === 0)
            : await runCheck(task.verificationContext.runner, {
                repositoryId: 'repo',
                cwd: task.workspace,
                command: process.execPath,
                args,
              });
          if (!preserve) executedChecks++;
          assert.equal(result.code, failure === 'check-recovery' && verificationRuns === 1 ? 1 : 0);
          if (failure === 'check-recovery' && verificationRuns > 1)
            assert.equal(sessionId, 'verification-session');
          onSession('verification-session');
          if (preserve) assert.equal(sessionId, 'verification-session');
          if (failure !== 'missing-evidence')
            onEvent({
              type: 'activity',
              kind: 'tool',
              summary: 'Executed discovered repository check',
              details: JSON.stringify(result),
            });
          h.verification = {
            checks: [
              {
                repositoryId: 'repo',
                command: process.execPath,
                args,
                cwd: task.workspace,
                code:
                  failure === 'failed-check' ||
                  (failure === 'check-recovery' && verificationRuns === 1)
                    ? 1
                    : 0,
                summary: 'Verified value contract',
              },
            ],
            requirements: [
              {
                repositoryId: 'repo',
                source: 'AGENTS.md',
                requirement: 'Verify the value contract',
                checkIndices: [0],
              },
            ],
          };
          if (prior)
            h.verification.reuse = [
              {
                checkIndex: 0,
                attemptId: prior.attemptId,
                reason:
                  'Same source fingerprint; report metadata correction or time continuation only.',
                freshCheckIndices: [],
              },
            ];
          if (
            failure?.startsWith('report-correction') &&
            (verificationRuns === 1 || failure.endsWith('exhausted'))
          )
            h.verification.requirements[0].checkIndices = [];
          if (failure === 'runtime-budget' && verificationRuns === 1)
            throw new RuntimeBudgetError('Execution budget exhausted', {
              extensions: 1,
              hardDeadlineAt: new Date().toISOString(),
            });
          if (failure === 'source-edit')
            await writeFile(join(task.workspace, 'value.txt'), 'unauthorized');
        }
        return h;
      },
    });
    if (failure === 'no-command-profile')
      f.store.setConfig({
        ...f.store.config,
        repositories: [{ ...f.store.config.repositories[0], checks: [] }],
      });
    const task = engine.create({ title: 'Verify using repository guidance', repositoryId: 'repo' });
    await engine.action(task.id, 'start');
    await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
    await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
    let final = await waitFor(f.store, task.id, (t) =>
      ['blocked', 'awaiting_final'].includes(t.status),
    );
    assert.ok(verified);
    if (failure === 'runtime-budget') {
      assert.equal(final.blockerDecision.kind, 'runtime_budget');
      assert.equal(
        final.attempts.some((a) => a.role === 'debug'),
        false,
      );
      await waitFor(f.store, task.id, () => !engine.running.has(task.id));
      await engine.action(task.id, 'resume');
      final = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_final');
      assert.equal(executedChecks, 1);
    }
    if (failure === 'check-recovery' || failure === 'failed-check') {
      assert.equal(
        final.attempts.some((a) => a.role === 'debug'),
        false,
      );
      assert.equal(verificationRuns, failure === 'failed-check' ? 3 : 2);
      if (failure === 'check-recovery') assert.equal(final.status, 'awaiting_final');
    }
    if (failure?.startsWith('report-correction')) {
      assert.equal(
        final.attempts.some((a) => a.role === 'debug'),
        false,
      );
      assert.equal(executedChecks, 1);
      assert.equal(verificationRuns, failure.endsWith('exhausted') ? 3 : 2);
      if (failure.endsWith('exhausted'))
        assert.equal(final.blockerDecision.kind, 'verification_report');
    }
    const rejected = [
      'missing-evidence',
      'failed-check',
      'source-edit',
      'report-correction-exhausted',
    ].includes(failure);
    assert.equal(final.status, rejected ? 'blocked' : 'awaiting_final', final.error);
    if (failure === 'repair-round') {
      assert.equal(verificationRuns, 2);
      assert.equal(final.round, 1);
      assert.ok(final.chosenApproach);
    }
    assert.ok(
      final.attempts.some(
        (a) => a.role === 'verifier' && a.harness === 'codex' && a.executionAccess === 'host',
      ),
    );
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    if (rejected) assert.ok(!final.verifiedFingerprint);
  });

test('oversized diffs are explicitly omitted without hiding Git failures', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  const baseCommit = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'value.txt'), 'changed line\n'.repeat(1000));
  const task = { workspace: repo, workspaceRoot: repo, baseCommit };
  const before = await fingerprint(task);
  const snapshot = await diff(task, { maxBytes: 1024 });
  assert.equal(snapshot.omitted, true);
  assert.equal(snapshot.text, '');
  assert.match(snapshot.reason, /no partial patch/);
  assert.equal(await fingerprint(task), before);
  await assert.rejects(diff({ ...task, baseCommit: 'missing-base' }), /git.*failed/);
});

test('base synchronization checks state and preserves work and approvals', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo)] });
  const engine = f.makeEngine();
  const task = engine.create({ title: 'Preserve test work', repositoryId: 'repo' });
  const baseCommit = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'upstream.txt'), 'new baseline\n');
  await git(repo, ['add', 'upstream.txt']);
  await runProcess('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'test: advance baseline',
  ]);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'value.txt'), 'approved edits\n');
  Object.assign(task, {
    status: 'blocked',
    stage: 'verify',
    workspace: repo,
    workspaceRoot: repo,
    baseCommit,
    branch: 'feature/test',
    chosenApproach: { id: 'approved' },
    verifiedFingerprint: 'old',
    reviewedFingerprint: 'old',
    recovery: { active: true },
  });
  f.store.save(task);
  const expectedFingerprint = await fingerprint(task);
  const data = { expectedFingerprint, expectedBaseCommit: baseCommit, baseCommit: head };
  await assert.rejects(
    engine.action(task.id, 'sync-base', { ...data, expectedBaseCommit: head }),
    /Recorded base changed/,
  );
  await assert.rejects(
    engine.action(task.id, 'sync-base', { ...data, expectedFingerprint: 'stale' }),
    /Workspace changed/,
  );
  await assert.rejects(engine.action(task.id, 'sync-base', { ...data, baseCommit }), /must match/);
  engine.running.set(task.id, new AbortController());
  await assert.rejects(engine.action(task.id, 'sync-base', data), /active process/);
  engine.running.delete(task.id);
  const result = await engine.action(task.id, 'sync-base', data);
  assert.equal(result.baseCommit, head);
  assert.equal(result.status, 'paused');
  assert.equal(result.stage, 'verify');
  assert.equal(result.chosenApproach.id, 'approved');
  assert.equal(result.verifiedFingerprint, null);
  assert.equal(result.reviewedFingerprint, null);
  assert.equal(result.recovery, null);
  assert.equal(await fingerprint(result), expectedFingerprint);
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'approved edits\n');
  assert.ok(f.store.events(task.id).some((e) => e.type === 'workspace_base'));
});

test('verification preparation failures stop before starting a debugger', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({
    ...DEFAULT_CONFIG,
    repositories: [profile(repo, { verificationMode: 'agent' })],
  });
  let calls = 0;
  const engine = f.makeEngine({
    harness: async () => {
      calls++;
      throw Error('Should not start');
    },
  });
  const task = engine.create({ title: 'Prepare verification', repositoryId: 'repo' });
  Object.assign(task, {
    status: 'queued',
    stage: 'verify',
    workspace: repo,
    workspaceRoot: repo,
    baseCommit: 'missing-base',
    branch: 'feature/test',
    setupCompleted: true,
  });
  f.store.save(task);
  engine.tick();
  const blocked = await waitFor(f.store, task.id, (t) => t.status === 'blocked');
  assert.equal(blocked.blockerDecision.kind, 'relay_preparation');
  assert.equal(blocked.recovery, null);
  assert.equal(blocked.attempts.length, 1);
  assert.equal(calls, 0);
  assert.match(blocked.error, /Recorded base.*differs/);
  assert.equal(blocked.blockerDecision.baseUpdate.expectedBaseCommit, 'missing-base');
  assert.equal(
    blocked.blockerDecision.baseUpdate.baseCommit,
    await git(repo, ['rev-parse', 'HEAD']),
  );
  assert.equal(blocked.blockerDecision.baseUpdate.expectedFingerprint, await fingerprint(blocked));
});

test('base synchronization updates the selected repository and primary mirror only', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo)] });
  const engine = f.makeEngine();
  const task = engine.create({ title: 'Cross repository metadata', repositoryId: 'repo' });
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const primary = {
    repository: task.repository,
    workspace: repo,
    workspaceRoot: repo,
    branch: 'feature/test',
    baseCommit: head,
  };
  task.repositories = [primary, { repository: { id: 'second' }, baseCommit: 'untouched' }];
  Object.assign(task, primary, { status: 'paused', stage: 'verify' });
  f.store.save(task);
  const before = await fingerprint({ ...task, repositories: undefined });
  const result = await engine.action(task.id, 'sync-base', {
    repositoryId: 'repo',
    baseCommit: head,
    expectedBaseCommit: head,
    expectedFingerprint: before,
  });
  assert.equal(result.baseCommit, head);
  assert.equal(result.repositories[0].baseCommit, head);
  assert.equal(result.repositories[1].baseCommit, 'untouched');
});

test('follow-up edits retain the published workspace and require both approvals', async (t) => {
  const f = await fixture(t);
  const repo = await makeRepo(f.directory);
  const baseCommit = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'published.txt'), 'accepted work\n');
  await git(repo, ['add', '.']);
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'feat: published fixture',
  ]);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  f.store.setConfig({ ...DEFAULT_CONFIG, repositories: [profile(repo)] });
  const calls = [];
  const engine = f.makeEngine({
    harness: async ({ task, stage }) => {
      calls.push(stage);
      assert.match(task.followUpContext.request, /additional case/);
      if (stage === 'implement')
        await writeFile(join(task.workspace, 'value.txt'), 'follow-up edit\n');
      return { ...demoHandoff(task, stage), risks: [] };
    },
  });
  const task = engine.create({ title: 'Published task', repositoryId: 'repo' });
  Object.assign(task, {
    status: 'completed',
    stage: 'review',
    workspace: repo,
    workspaceRoot: repo,
    branch: 'feature/test',
    baseCommit,
    setupCompleted: true,
    chosenApproach: { id: 'old' },
    reviewedFingerprint: await fingerprint({ workspaceRoot: repo }),
    publication: { state: 'open', url: 'https://code.example/repo/pull/1' },
    approvals: [{ type: 'final', at: new Date().toISOString() }],
  });
  f.store.save(task);
  await engine.action(task.id, 'follow-up', { message: 'Add an additional case' });
  const planned = await waitFor(f.store, task.id, (t) => t.status === 'awaiting_plan');
  assert.deepEqual(calls, ['plan']);
  assert.equal(planned.workspace, repo);
  assert.equal(planned.baseCommit, baseCommit);
  assert.equal(planned.workspaceHead, head);
  assert.equal(planned.chosenApproach, null);
  assert.equal(planned.followUps.length, 1);
  assert.equal(planned.approvals.length, 1);
  assert.equal(planned.publication.state, 'open');
  assert.equal(engine.workspaceReservations.get(repo), task.id);
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'before\n');
  await assert.rejects(engine.action(task.id, 'accept'), /not awaiting final/);
  await engine.action(task.id, 'approve-plan', { optionId: 'shared-boundary' });
  const final = await waitFor(f.store, task.id, (t) =>
    ['awaiting_final', 'blocked'].includes(t.status),
  );
  assert.equal(final.status, 'awaiting_final', final.error);
  assert.deepEqual(calls, ['plan', 'implement', 'review']);
  assert.equal(final.attempts.find((a) => a.stage === 'verify').status, 'complete');
  assert.equal(await readFile(join(repo, 'published.txt'), 'utf8'), 'accepted work\n');
  assert.equal(final.followUpContext.id, final.attempts.at(-1).followUpId);
  await engine.action(task.id, 'accept');
  assert.equal(f.store.get(task.id).status, 'completed');
  assert.equal(engine.workspaceReservations.has(repo), false);
});

test('follow-up requests reject busy, cleaned and merged workspaces', async (t) => {
  const f = await fixture(t);
  const engine = f.makeEngine();
  const task = engine.create({ title: 'Unavailable task', demo: true });
  await assert.rejects(
    engine.action(task.id, 'follow-up', { message: 'Edit' }),
    /Finish the current/,
  );
  task.status = 'completed';
  task.publication = { state: 'merged' };
  f.store.save(task);
  await assert.rejects(
    engine.action(task.id, 'follow-up', { message: 'Edit' }),
    /Create a new task/,
  );
  task.publication = null;
  task.demo = false;
  task.workspace = null;
  f.store.save(task);
  await assert.rejects(engine.action(task.id, 'follow-up', { message: 'Edit' }), /cleaned up/);
  assert.equal(f.store.get(task.id).status, 'completed');
});
