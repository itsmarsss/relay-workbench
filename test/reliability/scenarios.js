import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../../server/workspace.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class WorkflowProcess {
  constructor(directory, trace) {
    this.trace = trace;
    this.pending = new Map();
    this.checkpoints = [];
    this.providers = [];
    this.serial = 0;
    this.output = '';
    this.child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [directory], {
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    for (const stream of [this.child.stdout, this.child.stderr])
      stream.on('data', (chunk) => {
        this.output = (this.output + chunk).slice(-32000);
      });
    this.ready = new Promise((resolve, reject) => {
      this.readyTimer = setTimeout(
        () => reject(new Error('Workflow fixture did not start')),
        15000,
      );
      this.child.on('message', (message) => {
        if (message.type === 'ready') {
          clearTimeout(this.readyTimer);
          resolve();
        }
        if (message.type === 'provider-started') this.providers.push(message.pid);
        if (message.type === 'checkpoint') {
          this.checkpoints.push(message);
          this.trace.push(message);
        }
        if (message.type === 'response') {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            message.error
              ? pending.reject(new Error(message.error))
              : pending.resolve(message.value);
          }
        }
      });
      this.child.on('error', reject);
      this.child.on('exit', (code, signal) => {
        clearTimeout(this.readyTimer);
        const error = new Error(`Workflow fixture exited (${code ?? signal}): ${this.output}`);
        reject(error);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      });
    });
  }
  request(name, args = {}) {
    if (!this.child.connected) return Promise.reject(new Error('Workflow fixture is disconnected'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Fixture command timed out: ${name}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, name, args }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  waitForExit() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode)
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const complete = () => {
        clearTimeout(timer);
        this.child.removeListener('exit', complete);
        resolve();
      };
      const timer = setTimeout(() => {
        this.child.removeListener('exit', complete);
        reject(new Error('Workflow fixture did not exit'));
      }, 5000);
      this.child.once('exit', complete);
    });
  }
  async crash() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode) return;
    this.child.kill('SIGKILL');
    await this.waitForExit();
  }
  async close() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode) return;
    try {
      await this.request('shutdown');
      await this.waitForExit();
    } catch {
      await this.crash();
    }
  }
}
class Fixture {
  constructor(directory) {
    this.directory = directory;
    this.trace = [];
    this.snapshots = [];
    this.processes = [];
  }
  async boot(initialize = false) {
    this.process = new WorkflowProcess(this.directory, this.trace);
    this.processes.push(this.process);
    await this.process.ready;
    if (initialize) await this.process.request('initialize');
    return this.snapshot();
  }
  request(name, args) {
    return this.process.request(name, args);
  }
  async snapshot(inspect = false) {
    return this.request('snapshot', { inspect });
  }
  async record(label) {
    const snapshot = await this.snapshot(true);
    this.snapshots.push({ label, ...snapshot });
    return snapshot;
  }
  async drive(predicate, choose = () => 'complete', timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const snapshot = await this.snapshot();
      if (predicate(snapshot)) return snapshot;
      const checkpoint = this.process.checkpoints.shift();
      if (checkpoint)
        await this.request('release', { id: checkpoint.id, mode: choose(checkpoint) });
      else await pause(25);
    }
    throw new Error(
      `Workflow did not reach its expected checkpoint: ${JSON.stringify((await this.snapshot()).task)}`,
    );
  }
  async hold(stage, phase) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const checkpoint = this.process.checkpoints[0];
      if (checkpoint?.stage === stage && (!phase || checkpoint.phase === phase)) return checkpoint;
      if (checkpoint) {
        this.process.checkpoints.shift();
        await this.request('release', { id: checkpoint.id });
      } else await pause(25);
    }
    throw new Error(`Missing fixture checkpoint: ${stage}/${phase ?? ''}`);
  }
  async plan() {
    await this.request('action', { action: 'start' });
    const snapshot = await this.drive((s) => s.task.status === 'awaiting_plan' && !s.running);
    assert.equal(snapshot.task.approvals.length, 0);
    assert.equal(
      snapshot.task.attempts.some((a) => a.stage === 'implement'),
      false,
    );
    return snapshot;
  }
  async approve() {
    await this.request('action', { action: 'approve-plan', data: { optionId: 'shared-boundary' } });
  }
  async final() {
    return this.drive((s) => s.task.status === 'awaiting_final' && !s.running);
  }
  async accepted() {
    await this.plan();
    await this.approve();
    await this.final();
    await this.request('action', { action: 'accept' });
    return this.record('accepted');
  }
}
const completedStages = (task) =>
  task.attempts.filter((a) => a.status === 'complete' && !a.role).map((a) => [a.id, a.stage]);

export const reliabilityScenarios = [
  {
    id: 'approval-gates',
    title: 'Normal workflow stops at both human gates',
    async run(f) {
      await assert.rejects(f.request('publish'), /Accept a live task/);
      await f.plan();
      await assert.rejects(f.request('action', { action: 'accept' }));
      assert.equal((await f.record('awaiting-plan')).value, 'before\n');
      await f.approve();
      await f.final();
      await assert.rejects(f.request('publish'), /Accept a live task/);
      const final = await f.record('awaiting-final');
      assert.equal(final.value, 'after\n');
      assert.equal(final.task.status, 'awaiting_final');
      await f.request('action', { action: 'accept' });
      assert.equal((await f.record('completed')).task.status, 'completed');
    },
  },
  {
    id: 'malformed-handoff',
    title: 'Malformed provider output repairs in the current specialist',
    async run(f) {
      let injected = false;
      await f.request('action', { action: 'start' });
      await f.drive(
        (s) => s.task.status === 'awaiting_plan' && !s.running,
        (c) => {
          if (c.stage === 'investigate' && !injected) {
            injected = true;
            return 'malformed';
          }
          return 'complete';
        },
      );
      const { task } = await f.record('repaired-invalid-output');
      assert.ok(injected);
      assert.equal(task.attempts.filter((a) => a.role === 'debug').length, 0);
      assert.equal(task.approvals.length, 0);
      assert.ok(task.attempts.some((a) => a.status === 'failed'));
    },
  },
  {
    id: 'provider-exit',
    title: 'Provider process exit preserves partial implementation and native session',
    async run(f) {
      const plan = await f.plan();
      await f.approve();
      let injected = false;
      await f.drive(
        (s) => s.task.status === 'awaiting_final' && !s.running,
        (c) => {
          if (c.stage === 'implement' && !injected) {
            injected = true;
            return 'exit';
          }
          return 'complete';
        },
      );
      const final = await f.record('recovered-provider-exit');
      assert.ok(injected);
      assert.equal(final.value, 'after\n');
      for (const [id] of completedStages(plan.task))
        assert.ok(final.task.attempts.some((a) => a.id === id && a.status === 'complete'));
      const implementation = f.trace.filter((c) => c.stage === 'implement');
      assert.equal(implementation.length, 2);
      assert.equal(implementation[1].sessionId, 'reliability-implement');
      assert.equal(
        final.task.attempts.some((a) => a.role === 'debug'),
        false,
      );
    },
  },
  {
    id: 'bounded-invalid-output',
    title: 'Repeated invalid output reaches a finite stop',
    async run(f) {
      await f.request('action', { action: 'start' });
      await f.drive(
        (s) => s.task.status === 'blocked' && !s.running,
        () => 'malformed',
      );
      const { task } = await f.record('bounded-stop');
      assert.ok(f.trace.length <= 10, `Unbounded retries: ${f.trace.length}`);
      assert.ok(task.attempts.length <= 10);
      assert.equal(task.approvals.length, 0);
      assert.equal(
        task.attempts.some((a) => a.stage === 'implement'),
        false,
      );
    },
  },
  {
    id: 'runtime-budget',
    title: 'A real stalled provider exhausts its budget without starting a debugger',
    async run(f) {
      await f.plan();
      await f.approve();
      let injected = false;
      await f.drive(
        (s) => s.task.status === 'blocked' && !s.running,
        (c) => {
          if (c.stage === 'implement' && !injected) {
            injected = true;
            return 'stall';
          }
          return 'complete';
        },
      );
      const stopped = await f.record('budget-exhausted');
      assert.ok(injected);
      assert.equal(stopped.task.blockerDecision.kind, 'runtime_budget');
      assert.equal(
        stopped.task.attempts.some((a) => a.role === 'debug'),
        false,
      );
      assert.equal(stopped.value, 'after\n');
      await f.request('action', { action: 'resume' });
      await f.final();
      assert.equal((await f.record('continued-budget')).value, 'after\n');
    },
  },
  {
    id: 'cancel-at-checkpoint',
    title: 'Cancellation stops progression and releases the writer',
    async run(f) {
      await f.plan();
      await f.approve();
      await f.hold('implement');
      const before = await f.record('before-cancel');
      await f.request('action', { action: 'cancel' });
      await f.drive((s) => s.task.status === 'cancelled' && !s.running);
      const after = await f.record('cancelled');
      assert.equal(after.value, before.value);
      assert.equal(after.task.workspaceRoot, before.task.workspaceRoot);
      assert.equal(after.reservations.length, 0);
      assert.equal(
        after.task.attempts.some((a) => a.stage === 'review'),
        false,
      );
    },
  },
  {
    id: 'crash-during-implementation',
    title: 'SIGKILL and reopen preserve approvals, worktree, edits and completed stages',
    async run(f) {
      await f.plan();
      await f.approve();
      await f.hold('implement');
      const traceAtCrash = f.trace.length;
      const checkpoint = f.process.checkpoints.shift();
      await f.request('release', { id: checkpoint.id, mode: 'hold' });
      const providerDeadline = Date.now() + 10000;
      while (!f.process.providers.length && Date.now() < providerDeadline) await pause(25);
      const providerPid = f.process.providers[0];
      assert.ok(Number.isInteger(providerPid), 'A real provider must be running at the crash');
      const before = await f.record('before-crash');
      await f.process.crash();
      const orphanDeadline = Date.now() + 5000;
      let providerAlive = true;
      while (Date.now() < orphanDeadline) {
        try {
          process.kill(providerPid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') {
            providerAlive = false;
            break;
          }
          throw error;
        }
        await pause(25);
      }
      assert.equal(providerAlive, false, 'The provider must exit after its Relay parent dies');
      await f.boot();
      const recovered = await f.record('after-restart');
      assert.equal(recovered.task.status, 'interrupted');
      assert.equal(recovered.running, false);
      assert.equal(recovered.task.workspaceRoot, before.task.workspaceRoot);
      assert.equal(recovered.value, before.value);
      assert.deepEqual(recovered.task.approvals, before.task.approvals);
      assert.deepEqual(completedStages(recovered.task), completedStages(before.task));
      assert.equal(recovered.task.attempts.at(-1).status, 'interrupted');
      await assert.rejects(f.request('action', { action: 'resume' }), /Wait/);
      await pause(Math.max(0, recovered.task.recoveryNotBefore - Date.now()) + 20);
      await f.request('action', { action: 'resume' });
      await f.final();
      const final = await f.record('after-explicit-resume');
      assert.equal(final.value, 'after\n');
      assert.equal(
        f.trace
          .slice(traceAtCrash)
          .some((c) => ['triage', 'investigate', 'plan'].includes(c.stage)),
        false,
        'Restart must not replay completed stages',
      );
      assert.equal(
        f.trace.filter((c) => c.stage === 'implement').at(-1).sessionId,
        'reliability-implement',
      );
      assert.deepEqual(
        completedStages(final.task).slice(0, completedStages(before.task).length),
        completedStages(before.task),
      );
    },
  },
  {
    id: 'crash-after-publication-commit',
    title: 'Publication restart reuses the accepted commit and rejects subsequent source edits',
    async run(f) {
      await f.accepted();
      await f.request('publish');
      await f.hold('publish', 'after-commit');
      const committed = await f.record('commit-before-crash');
      await f.process.crash();
      await f.boot();
      const restarted = await f.record('publication-interrupted');
      assert.equal(restarted.task.delivery.status, 'interrupted');
      assert.equal(restarted.task.status, 'completed');
      assert.equal(restarted.head, committed.head);
      await f.request('publish');
      await f.drive((s) => s.task.delivery.status === 'complete' && !s.publicationRunning);
      const published = await f.record('publication-resumed');
      assert.equal(published.head, committed.head);
      assert.equal(published.commitCount, committed.commitCount);
      assert.equal(published.reservations.length, 0);
      assert.equal(published.task.publication.state, 'open');
      await f.request('edit', { value: 'unaccepted edit\n' });
      await assert.rejects(f.request('publish'), /changed|acceptance|accepted/i);
    },
  },
];

for (const gate of ['awaiting_plan', 'awaiting_final']) {
  reliabilityScenarios.push({
    id: `restart-${gate.replaceAll('_', '-')}`,
    title: `Restart at ${gate} preserves the human gate without replaying stages`,
    async run(f) {
      await f.plan();
      if (gate === 'awaiting_final') {
        await f.approve();
        await f.final();
      }
      const before = await f.record('gate-before-crash');
      const checkpoints = f.trace.length;
      await f.process.crash();
      await f.boot();
      const after = await f.record('gate-after-restart');
      assert.equal(after.task.status, gate);
      assert.equal(after.running, false);
      assert.deepEqual(after.task.approvals, before.task.approvals);
      assert.deepEqual(after.task.attempts, before.task.attempts);
      assert.equal(after.task.reviewedFingerprint, before.task.reviewedFingerprint);
      assert.equal(f.trace.length, checkpoints);
      await assert.rejects(f.request('publish'), /Accept a live task/);
      if (gate === 'awaiting_plan') {
        await f.approve();
        await f.final();
      }
      await f.request('action', { action: 'accept' });
      assert.equal((await f.record('accepted-after-restart')).task.status, 'completed');
    },
  });
}

export async function runReliabilityScenario(id) {
  const scenario = reliabilityScenarios.find((scenario) => scenario.id === id);
  if (!scenario) throw new Error(`Unknown reliability scenario: ${id}`);
  const directory = await mkdtemp(join(tmpdir(), 'relay-reliability-'));
  const fixture = new Fixture(directory);
  const startedAt = new Date().toISOString();
  let failure;
  try {
    const repository = join(directory, 'repository');
    await mkdir(repository);
    await git(repository, ['init', '-b', 'main']);
    await writeFile(join(repository, 'value.txt'), 'before\n');
    await git(repository, ['add', '--all']);
    await git(repository, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'test: initial fixture',
    ]);
    await fixture.boot(true);
    await scenario.run(fixture);
  } catch (error) {
    failure = error;
    try {
      await fixture.record('failure');
    } catch {}
  } finally {
    for (const process of fixture.processes) {
      try {
        await process.close();
      } catch (error) {
        failure ??= error;
      }
    }
  }
  const result = {
    id,
    title: scenario.title,
    passed: !failure,
    startedAt,
    durationMs: Date.now() - Date.parse(startedAt),
    checkpoints: fixture.trace,
    snapshots: fixture.snapshots,
    ...(failure
      ? {
          error: failure.stack,
          artifactDirectory: directory,
          processOutput: fixture.processes.map((p) => p.output),
        }
      : {}),
  };
  if (failure) await writeFile(join(directory, 'failure.json'), JSON.stringify(result, null, 2));
  else await rm(directory, { recursive: true, force: true });
  return result;
}
