import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { newTask, requireValue, text, HARNESSES } from './domain.js';
import { prepareWorkspace, fingerprint, inspectRepository } from './workspace.js';
import { executeHarness, demoHandoff } from './harness.js';
import { runProcess, executableExists } from './process.js';

export class Engine {
  constructor(store, { harness = executeHarness, demoDelay = 650 } = {}) {
    this.store = store;
    this.harness = harness;
    this.demoDelay = demoDelay;
    this.running = new Map();
    this.actionLocks = new Set();
    this.workspaceReservations = new Map();
    this.stopping = false;
    for (const task of store.all()) {
      if (
        task.repository.strategy === 'attach' &&
        task.workspaceRoot &&
        !['completed', 'cancelled'].includes(task.status)
      )
        this.workspaceReservations.set(task.workspaceRoot, task.id);
      if (task.submission?.status === 'running') {
        task.submission.status = 'interrupted';
        task.submission.error =
          'Submission was interrupted. Inspect the remote and local commit before running your provider command manually.';
        store.save(task, { type: 'submission', summary: task.submission.error });
      }
      if (['running', 'queued'].includes(task.status)) {
        task.status = 'interrupted';
        task.recoveryNotBefore = Date.now() + 3000;
        task.error =
          'The server stopped before this stage finished. Inspect the workspace, then resume explicitly.';
        for (const attempt of task.attempts)
          if (attempt.status === 'running') {
            attempt.status = 'interrupted';
            attempt.finishedAt = new Date().toISOString();
          }
        store.save(task, { type: 'interrupted', summary: task.error });
      }
    }
  }
  create(raw) {
    const task = newTask(raw, this.store.config);
    requireValue(
      Object.values(task.routing).every((id) => HARNESSES.includes(id)),
      'Invalid harness routing',
    );
    return this.store.save(task, {
      type: 'created',
      summary: task.demo
        ? 'Demo task created. All results will be simulated.'
        : 'Task created. Ready to start.',
    });
  }
  async action(id, action, data = {}) {
    requireValue(!this.actionLocks.has(id), 'Another action is in progress', 409);
    this.actionLocks.add(id);
    try {
      const task = this.store.get(id);
      requireValue(task, 'Task not found', 404);
      const status = task.status;
      if (action === 'start' || action === 'resume') {
        requireValue(
          action === 'start'
            ? status === 'draft'
            : ['blocked', 'paused', 'interrupted'].includes(status),
          'Task cannot start or resume in its current state',
          409,
        );
        requireValue(!this.running.has(id), 'Wait for the current process to stop', 409);
        requireValue(
          !task.recoveryNotBefore || Date.now() >= task.recoveryNotBefore,
          'Wait a few seconds for interrupted worker processes to terminate, then resume.',
          409,
        );
        if (!task.demo) {
          requireValue(
            task.repository.checks.length > 0,
            'Configure at least one verification command before starting a live task',
          );
          await inspectRepository(task.repository);
          for (const stage of [
            'investigate',
            'plan',
            'implement',
            'review',
            ...(task.smartRouting ? ['triage'] : []),
          ]) {
            const config = this.store.config.harnesses[task.routing[stage]];
            requireValue(
              config?.enabled && (await executableExists(config.command)),
              `Harness for ${stage} is disabled or unavailable`,
            );
          }
        }
        task.status = 'queued';
        task.error = null;
        this.store.save(task, {
          type: 'queued',
          summary:
            action === 'start'
              ? 'Workflow queued.'
              : `Resuming ${task.stage} after explicit approval.`,
        });
      } else if (action === 'approve-plan') {
        requireValue(status === 'awaiting_plan', 'Task is not awaiting an approach', 409);
        const plan = task.attempts.findLast(
          (a) => a.stage === 'plan' && a.status === 'complete',
        )?.handoff;
        const option = plan?.options.find((o) => o.id === data.optionId);
        requireValue(option, 'Select one of the proposed approaches');
        task.chosenApproach = option;
        task.approvals.push({
          type: 'approach',
          option,
          at: new Date().toISOString(),
          note: text(data.note ?? '', 'Note', 10000, true),
        });
        task.status = 'queued';
        task.stage = 'implement';
        task.error = null;
        this.store.save(task, {
          type: 'approval',
          summary: `Approach approved: ${option.title}`,
          details: data.note ?? '',
        });
      } else if (action === 'request-changes') {
        requireValue(
          ['awaiting_plan', 'awaiting_final'].includes(status),
          'Task is not awaiting approval',
          409,
        );
        const note = text(data.note, 'Feedback', 20000);
        task.messages.push({ at: new Date().toISOString(), text: note, role: 'user' });
        task.stage = status === 'awaiting_plan' ? 'plan' : 'implement';
        task.status = 'queued';
        task.reviewedFingerprint = null;
        this.store.save(task, { type: 'feedback', summary: 'Changes requested.', details: note });
      } else if (action === 'accept') {
        requireValue(status === 'awaiting_final', 'Task is not awaiting final approval', 409);
        if (!task.demo)
          requireValue(
            (await fingerprint(task)) === task.reviewedFingerprint,
            'The workspace changed after review. Request changes to rerun verification and review.',
            409,
          );
        task.status = 'completed';
        task.approvals.push({
          type: 'final',
          at: new Date().toISOString(),
          fingerprint: task.reviewedFingerprint,
        });
        this.releaseReservation(id);
        this.store.save(task, {
          type: 'accepted',
          summary: 'Final result accepted. Workspace and branch retained.',
        });
      } else if (action === 'pause' || action === 'cancel') {
        requireValue(
          !['completed', 'cancelled'].includes(status),
          'Task has already finished',
          409,
        );
        task.status = action === 'pause' ? 'paused' : 'cancelled';
        if (action === 'cancel') this.releaseReservation(id);
        this.store.save(task, {
          type: task.status,
          summary:
            action === 'pause'
              ? 'Paused. Resume when ready; an interrupted stage will run again.'
              : 'Cancelled. Existing code and worktree retained.',
        });
        this.running.get(id)?.abort();
      } else if (action === 'message') {
        const message = text(data.message, 'Message', 20000);
        task.messages.push({ at: new Date().toISOString(), text: message, role: 'user' });
        this.store.save(task, {
          type: 'feedback',
          summary: 'Context added for the next stage.',
          details: message,
        });
      } else throw new Error('Unknown task action');
      this.tick();
      return this.store.get(id);
    } finally {
      this.actionLocks.delete(id);
    }
  }
  tick() {
    if (this.stopping) return;
    const tasks = this.store.all().reverse();
    const occupied = new Set(
      [...this.running.keys()].map(
        (id) => this.store.get(id)?.workspaceRoot || this.store.get(id)?.repository.path,
      ),
    );
    for (const task of tasks) {
      if (this.running.size >= this.store.config.concurrency) break;
      if (task.status !== 'queued' || this.running.has(task.id)) continue;
      const key = task.workspaceRoot || task.repository.path;
      if (!task.demo && occupied.has(key)) continue;
      if (!task.demo) occupied.add(key);
      const controller = new AbortController();
      this.running.set(task.id, controller);
      this.run(task.id, controller.signal)
        .catch((error) => {
          const current = this.store.get(task.id);
          if (current && !['paused', 'cancelled'].includes(current.status)) {
            current.status = 'blocked';
            current.error = error.message;
            const attempt = current.attempts.findLast((a) => a.status === 'running');
            if (attempt) {
              attempt.status = 'failed';
              attempt.error = error.message;
              attempt.finishedAt = new Date().toISOString();
            }
            this.store.save(current, { type: 'blocked', summary: error.message });
          } else if (current) {
            const attempt = current.attempts.findLast((a) => a.status === 'running');
            if (attempt) {
              attempt.status = 'interrupted';
              attempt.finishedAt = new Date().toISOString();
              this.store.save(current);
            }
          }
        })
        .finally(() => {
          this.running.delete(task.id);
          this.tick();
        });
    }
  }
  async run(id, signal) {
    let task = this.store.get(id);
    task.status = 'running';
    this.store.save(task, {
      type: 'started',
      stage: task.stage,
      summary: `Starting ${task.stage}.`,
    });
    if (!task.demo) {
      if (task.repository.strategy === 'attach') {
        const info = await inspectRepository(task.repository);
        const owner = this.workspaceReservations.get(info.root);
        requireValue(
          !owner || owner === id,
          'This checkout is reserved by another task. Complete or cancel it first.',
          409,
        );
        this.workspaceReservations.set(info.root, id);
      }
      await prepareWorkspace(task, this.store.directory, this.store.all());
      if (signal.aborted) throw new Error('Execution cancelled');
      task.messages = this.store.get(id).messages;
      this.store.save(task, {
        type: 'workspace',
        summary: 'Shared workspace ready.',
        details: task.workspace,
      });
      if (!task.setupCompleted) {
        for (const cmd of task.repository.setup) {
          const result = await runProcess(cmd.command, cmd.args, {
            cwd: task.workspace,
            signal,
            timeout: this.store.config.timeoutMinutes * 60000,
            onLine: (line, stream) =>
              this.store.event(id, { type: 'transcript', stage: 'setup', stream, text: line }),
          });
          if (result.code !== 0)
            throw new Error(`Repository setup failed: ${cmd.command} exited ${result.code}`);
        }
        if (signal.aborted) throw new Error('Execution cancelled');
        task.setupCompleted = true;
        task.messages = this.store.get(id).messages;
        this.store.save(task);
      }
    } else if (!task.workspace) {
      task.workspace = 'Demo workspace · no files changed';
      task.branch = `demo/${id.slice(0, 8)}`;
      task.baseCommit = 'simulated';
      this.store.save(task);
    }
    const stage = task.stage;
    const harness = stage === 'verify' ? 'checks' : task.routing[stage];
    const attempt = {
      id: randomUUID(),
      stage,
      harness,
      round: task.round,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    task.attempts.push(attempt);
    this.store.save(task, {
      type: 'stage_started',
      stage,
      harness,
      summary:
        stage === 'verify'
          ? 'Running repository verification commands.'
          : `${harness} is working on ${stage}.`,
    });
    const before = !task.demo ? await fingerprint(task) : 'demo';
    if (stage === 'review')
      requireValue(
        task.demo || task.verifiedFingerprint === before,
        'Workspace changed after verification. Request changes or rerun implementation before review.',
      );
    let handoff;
    if (stage === 'verify') {
      const checks = [];
      if (task.demo) {
        await delay(this.demoDelay, undefined, { signal });
        checks.push({
          command: 'Demo checks',
          args: [],
          code: 0,
          stdout: 'Simulated checks passed.',
          stderr: '',
          durationMs: this.demoDelay,
        });
      } else
        for (const command of task.repository.checks) {
          const started = Date.now();
          const result = await runProcess(command.command, command.args, {
            cwd: task.workspace,
            signal,
            timeout: this.store.config.timeoutMinutes * 60000,
            onLine: (line, stream) =>
              this.store.event(id, {
                type: 'transcript',
                stage,
                attemptId: attempt.id,
                stream,
                text: line.slice(0, 40000),
              }),
          });
          checks.push({ ...command, ...result, durationMs: Date.now() - started });
        }
      const passed = checks.length > 0 && checks.every((c) => c.code === 0);
      handoff = {
        summary: passed
          ? 'All configured verification commands passed.'
          : 'Verification failed. Returning evidence for repair.',
        details: checks
          .map(
            (c) =>
              `${c.command} ${c.args.join(' ')} → ${c.code}\n${c.stdout.slice(-12000)}\n${c.stderr.slice(-6000)}`,
          )
          .join('\n\n'),
        checks,
        files: [],
        evidence: checks.map((c) => `Exit ${c.code}: ${c.command} ${c.args.join(' ')}`),
        risks: [],
        options: [],
        findings: [],
        verdict: passed ? 'complete' : 'changes_requested',
        routing: task.routing,
      };
    } else if (stage === 'triage' && !task.smartRouting) {
      handoff = {
        ...demoHandoff(task, stage),
        summary: 'Using your configured specialist routing.',
        details: Object.entries(task.routing)
          .map(([s, h]) => `${s}: ${h}`)
          .join('\n'),
        evidence: ['Routing selected in local configuration.'],
        risks: [],
        files: [],
      };
    } else if (task.demo) {
      await delay(this.demoDelay, undefined, { signal });
      handoff = demoHandoff(task, stage);
    } else {
      requireValue(this.store.config.harnesses[harness]?.enabled, `${harness} is disabled`);
      handoff = await this.harness({
        task,
        stage,
        harness,
        config: structuredClone(this.store.config),
        directory: this.store.directory,
        attemptId: attempt.id,
        signal,
        onEvent: (event) =>
          this.store.event(id, { ...event, stage, harness, attemptId: attempt.id }),
      });
    }
    if (signal.aborted) throw new Error('Execution cancelled');
    const after = !task.demo ? await fingerprint(task) : 'demo';
    if (['triage', 'investigate', 'plan', 'review'].includes(stage) && before !== after)
      throw new Error(
        `${stage} modified the workspace despite being read-only. Inspect the diff before resuming.`,
      );
    task = this.store.get(id);
    const savedAttempt = task.attempts.find((a) => a.id === attempt.id);
    savedAttempt.handoff = handoff;
    savedAttempt.finishedAt = new Date().toISOString();
    savedAttempt.status = 'complete';
    savedAttempt.fingerprint = after;
    if (handoff.verdict === 'blocked') {
      task.status = 'blocked';
      task.error = handoff.summary;
    } else if (stage === 'triage') {
      if (task.smartRouting) {
        for (const [s, h] of Object.entries(handoff.routing)) {
          requireValue(
            HARNESSES.includes(h) && this.store.config.harnesses[h].enabled,
            'Triage selected an unavailable harness',
          );
          task.routing[s] = h;
        }
      }
      task.stage = 'investigate';
      task.status = 'queued';
    } else if (stage === 'investigate') {
      task.stage = 'plan';
      task.status = 'queued';
    } else if (stage === 'plan') {
      task.status = 'awaiting_plan';
    } else if (stage === 'implement') {
      task.stage = 'verify';
      task.status = 'queued';
    } else if (stage === 'verify') {
      if (handoff.verdict === 'complete') {
        task.verifiedFingerprint = after;
        task.stage = 'review';
        task.status = 'queued';
      } else this.repair(task, handoff.summary);
    } else if (stage === 'review') {
      requireValue(
        task.demo || task.verifiedFingerprint === before,
        'Workspace changed after verification. Run verification again before review.',
      );
      if (handoff.verdict === 'changes_requested' || handoff.findings.length > 0)
        this.repair(task, handoff.summary);
      else {
        task.reviewedFingerprint = after;
        task.status = 'awaiting_final';
      }
    }
    this.store.save(task, {
      type: 'handoff',
      stage,
      harness,
      summary: handoff.summary,
      details: handoff.details,
      attemptId: attempt.id,
    });
    if (['awaiting_plan', 'awaiting_final'].includes(task.status))
      this.store.event(id, {
        type: 'decision',
        summary:
          task.status === 'awaiting_plan'
            ? 'Choose an approach to authorize implementation.'
            : 'Review the diff and accept the final result.',
      });
  }
  repair(task, reason) {
    task.round++;
    task.stage = 'implement';
    task.reviewedFingerprint = null;
    if (task.round > this.store.config.maxRepairRounds) {
      task.status = 'blocked';
      task.error = `Repair limit reached. ${reason} Add feedback and resume explicitly to continue.`;
    } else task.status = 'queued';
  }
  releaseReservation(id) {
    for (const [root, owner] of this.workspaceReservations)
      if (owner === id) this.workspaceReservations.delete(root);
  }
  async stop() {
    this.stopping = true;
    for (const controller of this.running.values()) controller.abort();
    while (this.running.size) await delay(25);
  }
}
