import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBudget } from '../server/runtime-budget.js';
import { runProcess } from '../server/process.js';
import { runCheck } from '../server/check-runner.js';
import { prepareCheckRunner, readCheckJournal } from '../server/verification-evidence.js';
import { validateVerification } from '../server/verification.js';
import { blockerDecisionView } from '../public/blocker-decision.js';

test('runtime budget extends on recent progress but always stops at its absolute cap', () => {
  const budget = new RuntimeBudget({
    timeout: 100,
    maxTimeout: 200,
    progressWindow: 30,
    startedAt: 1000,
  });
  assert.equal(budget.evaluate(1099, 1095), 'wait');
  assert.equal(budget.evaluate(1100, 1095), 'extend');
  assert.equal(budget.softDeadline, 1150);
  assert.equal(budget.evaluate(1150, 1145), 'extend');
  assert.equal(budget.evaluate(1200, 1199), 'stop');
  assert.equal(budget.hardDeadline, 1200);
  const stale = new RuntimeBudget({ timeout: 100, progressWindow: 30, startedAt: 1000 });
  assert.equal(stale.evaluate(1100, 1050), 'stop');
  assert.equal(stale.evaluate(1100, null), 'stop');
});
test('supervised process can finish during a bounded extension and preserves output at budget exhaustion', async () => {
  let progress = Date.now(),
    extensions = 0;
  const result = await runProcess(
    process.execPath,
    ['-e', "setTimeout(()=>console.log('passed'), 220)"],
    {
      timeout: 200,
      progressPolicy: {
        maxTimeout: 1200,
        progressWindow: 1000,
        lastProgressAt: () => (progress = Date.now()),
      },
      onBudget: (b) => (extensions = b.extensions),
    },
  );
  assert.equal(result.code, 0);
  assert.ok(extensions > 0);
  await assert.rejects(
    runProcess(process.execPath, ['-e', "console.log('recorded');setInterval(()=>{},1000)"], {
      timeout: 150,
      progressPolicy: { maxTimeout: 300, progressWindow: 1000, lastProgressAt: () => Date.now() },
    }),
    (error) => error.code === 'RUNTIME_BUDGET_EXHAUSTED' && error.stdout.includes('recorded'),
  );
});
async function runnerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-check-'));
  const root = join(directory, 'repo');
  await mkdir(root);
  const entries = [{ repository: { id: 'repo' }, workspaceRoot: root, workspace: root }];
  const runner = await prepareCheckRunner(
    directory,
    'task',
    'attempt',
    entries,
    'source-one',
    'settings-one',
    10000,
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root, runner };
}
test('check runner serializes concurrent requests and persists each exit before a handoff exists', async (t) => {
  const { directory, root, runner } = await runnerFixture(t);
  const trace = join(directory, 'trace');
  const args = (name) => [
    '-e',
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(trace)},'${name} start\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(trace)},'${name} end\\n');console.log('${name} done')},150)`,
  ];
  const [one, two] = await Promise.all([
    runCheck(runner, {
      repositoryId: 'repo',
      cwd: root,
      command: process.execPath,
      args: args('one'),
    }),
    runCheck(runner, {
      repositoryId: 'repo',
      cwd: root,
      command: process.execPath,
      args: args('two'),
    }),
  ]);
  assert.equal(one.code, 0);
  assert.equal(two.code, 0);
  const lines = (await readFile(trace, 'utf8')).trim().split('\n');
  assert.ok(lines[0].startsWith('one') ? lines[1] === 'one end' : lines[1] === 'two end');
  const journal = await readCheckJournal(runner);
  assert.equal(journal.length, 2);
  assert.ok(journal.every((r) => r.status === 'complete' && r.sourceFingerprint === 'source-one'));
  assert.match(await readFile(one.logPath, 'utf8'), /one done/);
  const progress = JSON.parse(await readFile(runner.progressPath, 'utf8'));
  assert.equal(progress.status, 'complete');
  await assert.rejects(
    runCheck(runner, { repositoryId: 'repo', cwd: directory, command: process.execPath, args: [] }),
    /outside/,
  );
});
test('interrupted checks remain incomplete and release their resource reservation', async (t) => {
  const { root, runner } = await runnerFixture(t);
  const controller = new AbortController();
  const pending = runCheck(
    runner,
    {
      repositoryId: 'repo',
      cwd: root,
      command: process.execPath,
      args: ['-e', "console.log('started');setInterval(()=>{},1000)"],
    },
    controller.signal,
  );
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.code, null);
  const next = await runCheck(runner, {
    repositoryId: 'repo',
    cwd: root,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  assert.equal(next.code, 0);
  assert.equal(await readFile(next.logPath, 'utf8'), '');
  assert.equal((await readCheckJournal(runner)).length, 2);
});
test('reused verification needs provenance and fresh impact checks after source changes', () => {
  const check = {
    repositoryId: 'repo',
    command: 'test',
    args: ['all'],
    cwd: '/tmp/repo',
    code: 0,
    summary: 'Passed',
  };
  const fresh = { ...check, args: ['affected'] };
  const report = {
    checks: [check, fresh],
    requirements: [
      {
        repositoryId: 'repo',
        source: 'guidance',
        requirement: 'Regression checks',
        checkIndices: [0, 1],
      },
    ],
    reuse: [
      {
        checkIndex: 0,
        attemptId: 'prior',
        reason: 'Only a test name changed; the renamed cases pass freshly.',
        freshCheckIndices: [1],
      },
    ],
  };
  const context = {
    sourceFingerprint: 'new',
    priorEvidence: [
      { attemptId: 'prior', sourceFingerprint: 'old', reusable: true, report: { checks: [check] } },
    ],
    journal: [{ ...fresh, status: 'complete', sourceFingerprint: 'new' }],
  };
  assert.equal(
    validateVerification({ verification: report }, [{ repository: { id: 'repo' } }], true, context),
    report,
  );
  for (const change of [
    (r) => (r.reuse[0].freshCheckIndices = []),
    (r) => (r.reuse[0].attemptId = 'invented'),
    (r) => (r.reuse[0].reason = ''),
    (r) => (r.checks[0].args = ['different']),
    (r) => (r.reuse[0].freshCheckIndices = [0]),
    (r) => (r.reuse = []),
  ]) {
    const copy = structuredClone(report);
    change(copy);
    assert.throws(() =>
      validateVerification({ verification: copy }, [{ repository: { id: 'repo' } }], true, context),
    );
  }
  assert.throws(
    () =>
      validateVerification({ verification: report }, [{ repository: { id: 'repo' } }], true, {
        ...context,
        journal: [
          ...context.journal,
          {
            ...fresh,
            command: 'another-required-test',
            code: 1,
            status: 'complete',
            sourceFingerprint: 'new',
          },
        ],
      }),
    /supervised check failed/,
  );
  const html = blockerDecisionView({
    status: 'blocked',
    blockerDecision: { kind: 'runtime_budget' },
  });
  assert.ok(html.includes('Continue with more time'));
  assert.ok(!html.includes('Run debugger'));
});

test('exploratory diagnostic failures do not poison passing verification', () => {
  const check = {
    repositoryId: 'repo',
    command: 'test-tool',
    args: ['required'],
    cwd: '/tmp/repo',
    code: 0,
    summary: 'Passed',
  };
  const report = {
    checks: [check],
    requirements: [
      {
        repositoryId: 'repo',
        source: 'guidance',
        requirement: 'Required tests',
        checkIndices: [0],
      },
    ],
    reuse: [],
  };
  const entries = [{ repository: { id: 'repo' } }];
  const context = {
    sourceFingerprint: 'current',
    journal: [
      { ...check, status: 'complete', sourceFingerprint: 'current' },
      {
        ...check,
        id: 'probe',
        purpose: 'diagnostic',
        command: 'inspect-log',
        code: 1,
        status: 'complete',
        sourceFingerprint: 'current',
      },
    ],
  };
  assert.equal(validateVerification({ verification: report }, entries, true, context), report);
  const requiredFailure = structuredClone(context);
  requiredFailure.journal[1].purpose = 'verification';
  assert.throws(
    () => validateVerification({ verification: report }, entries, true, requiredFailure),
    /supervised check failed/,
  );
  const hiddenFailure = structuredClone(context);
  hiddenFailure.journal = [
    { ...check, code: 1, status: 'complete', sourceFingerprint: 'current' },
    { ...check, code: 0, purpose: 'diagnostic', status: 'complete', sourceFingerprint: 'current' },
  ];
  assert.throws(
    () => validateVerification({ verification: report }, entries, true, hiddenFailure),
    /supervised check failed/,
  );
  const fakePass = structuredClone(context);
  fakePass.journal[0].purpose = 'diagnostic';
  assert.throws(
    () => validateVerification({ verification: report }, entries, true, fakePass),
    /completed supervised check/,
  );
});

test('diagnostic runner records purpose and retains nonzero exit status', async (t) => {
  const { root, runner } = await runnerFixture(t);
  const probe = await runCheck(runner, {
    repositoryId: 'repo',
    cwd: root,
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    purpose: 'diagnostic',
  });
  assert.equal(probe.code, 1);
  assert.equal(probe.purpose, 'diagnostic');
  assert.equal(await readFile(probe.logPath, 'utf8'), '');
  const journal = await readCheckJournal(runner);
  assert.equal(journal[0].purpose, 'diagnostic');
  await assert.rejects(
    runCheck(runner, {
      repositoryId: 'repo',
      cwd: root,
      command: process.execPath,
      args: [],
      purpose: 'waived',
    }),
    /Invalid/,
  );
});
