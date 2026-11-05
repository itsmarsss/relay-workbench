import { randomUUID } from 'node:crypto';
import { workspaces, workspaceView, syncPrimary } from './task-repositories.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  newTask,
  reconfigureTask,
  executionConfig,
  requireValue,
  text,
  HARNESSES,
} from './domain.js';
import { prepareWorkspace, fingerprint, inspectRepository } from './workspace.js';
import { executeHarness, demoHandoff } from './harness.js';
import { runProcess, executableExists } from './process.js';

export class Engine {
  constructor(store, { harness = executeHarness, demoDelay = 650 } = {}) {
    this.store = store;
    this.harness = harness;
    this.demoDelay = demoDelay;
    this.running = new Map();
    this.manualRuns = new Map();
    this.actionLocks = new Set();
    this.workspaceReservations = new Map();
    this.stopping = false;
    for (const task of store.all()) {
      for (const entry of workspaces(task)) {
        if (
          entry.repository.strategy === 'attach' &&
          entry.workspaceRoot &&
          !['completed', 'cancelled'].includes(task.status)
        )
          this.workspaceReservations.set(entry.workspaceRoot, task.id);
      }
      for (const entry of workspaces(task)) {
        if (entry.submission?.status === 'running') {
          entry.submission.status = 'interrupted';
          entry.submission.error =
            'Submission interrupted. Inspect the provider and local commit before retrying manually.';
          store.save(task, {
            type: 'submission',
            repositoryId: entry.repository.id,
            summary: entry.submission.error,
          });
        }
      }
      if (['running', 'queued', 'manual'].includes(task.status)) {
        if (task.manual) task.manual.active = false;
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
  update(id, data) {
    requireValue(!this.stopping && !this.actionLocks.has(id), 'Another action is in progress', 409);
    requireValue(
      !this.running.has(id) && !this.manualRuns.has(id),
      'Wait for the active process to stop before editing.',
      409,
    );
    const task = this.store.get(id);
    requireValue(task, 'Task not found', 404);
    requireValue(
      !task.recoveryNotBefore || Date.now() >= task.recoveryNotBefore,
      'Wait for interrupted workers to stop before editing.',
      409,
    );
    const result = reconfigureTask(task, data, this.store.config);
    return this.store.save(result.task, {
      type: 'configuration',
      summary: result.reset
        ? 'Task settings updated. Workflow paused for fresh validation and approval.'
        : 'Task settings updated.',
      revision: result.task.configRevision,
    });
  }
  async action(id, action, data = {}) {
    requireValue(!this.stopping, 'Relay is shutting down', 409);
    requireValue(!this.actionLocks.has(id), 'Another action is in progress', 409);
    this.actionLocks.add(id);
    try {
      const task = this.store.get(id);
      requireValue(task, 'Task not found', 404);
      const status = task.status;
      if (action === 'takeover') {
        requireValue(
          !task.demo && !['draft', 'completed', 'cancelled'].includes(status),
          'Start a real workflow before taking over',
          409,
        );
        requireValue(
          !this.manualRuns.has(id) && status !== 'manual',
          'Manual control is already active',
          409,
        );
        const entry = workspaces(task).find(
          (r) => r.repository.id === (data.repositoryId ?? task.repository.id),
        );
        requireValue(
          entry?.workspace && entry.setupCompleted,
          'Wait for repository workspace setup to finish',
          409,
        );
        requireValue(await executableExists('tmux'), 'Install tmux to use terminal takeover');
        requireValue(
          !task.recoveryNotBefore || Date.now() >= task.recoveryNotBefore,
          'Wait for interrupted workers to stop',
          409,
        );
        task.status = 'manual';
        task.stage = task.chosenApproach ? 'verify' : 'investigate';
        task.repositoryCursor = 0;
        task.reviewedFingerprint = null;
        task.verifiedFingerprint = null;
        task.error = null;
        task.manual = {
          repositoryId: entry.repository.id,
          startedAt: new Date().toISOString(),
          active: false,
        };
        this.store.save(task, {
          type: 'manual',
          summary: `Stopping automation for manual control of ${entry.repository.name}.`,
        });
        this.running.get(id)?.abort();
        while (this.running.has(id)) await delay(25);
        requireValue(!this.stopping, 'Relay is shutting down', 409);
        const controller = new AbortController();
        const run = { controller, done: null };
        this.manualRuns.set(id, run);
        run.done = runProcess(process.env.SHELL || '/bin/sh', ['-i'], {
          cwd: entry.workspace,
          signal: controller.signal,
          timeout: 24 * 60 * 60 * 1000,
          terminal: { name: `${id.slice(0, 8)}-manual`, interactive: true },
          env: { RELAY_TASK_ID: id, RELAY_REPOSITORY_ID: entry.repository.id },
          onTerminal: (terminal) => {
            const current = this.store.get(id);
            current.manual = { ...current.manual, ...terminal, active: true };
            this.store.save(current, {
              type: 'terminal',
              summary: 'Manual terminal ready. Automation is paused.',
              details: terminal.attachCommand,
            });
          },
        })
          .catch((error) => {
            const current = this.store.get(id);
            if (!controller.signal.aborted)
              this.store.event(id, {
                type: 'activity',
                summary: `Manual terminal stopped: ${error.message}`,
              });
          })
          .finally(() => {
            this.manualRuns.delete(id);
            const current = this.store.get(id);
            if (current?.manual) {
              current.manual.active = false;
              this.store.save(current, {
                type: 'terminal',
                summary: 'Manual terminal closed. Return control when ready to continue.',
              });
            }
          });
      } else if (action === 'return-control') {
        requireValue(status === 'manual', 'Task is not under manual control', 409);
        const run = this.manualRuns.get(id);
        run?.controller.abort();
        await run?.done;
        const current = this.store.get(id);
        current.manual = null;
        current.status = 'queued';
        this.store.save(current, {
          type: 'queued',
          summary: current.chosenApproach
            ? 'Control returned. Running all repository checks and independent review.'
            : 'Control returned. Rebuilding the investigation and proposal for approval.',
        });
      } else if (action === 'start' || action === 'resume') {
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
          const roots = new Set();
          for (const entry of workspaces(task)) {
            requireValue(
              entry.repository.checks.length > 0,
              `Configure verification commands for ${entry.repository.name}`,
            );
            const info = await inspectRepository(entry.repository);
            requireValue(
              !roots.has(info.root),
              'Selected profiles refer to the same checkout; select one profile per repository',
            );
            roots.add(info.root);
          }
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
        task.repositoryCursor = 0;
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
        task.repositoryCursor = 0;
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
        for (const entry of workspaces(task))
          if (!task.demo) entry.acceptedFingerprint = await fingerprint(workspaceView(task, entry));
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
        const manual = this.manualRuns.get(id);
        manual?.controller.abort();
        await manual?.done;
        if (task.manual) task.manual.active = false;
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
          if (current && !['paused', 'cancelled', 'manual'].includes(current.status)) {
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
      // Reserve all attached checkouts before the first setup or harness can run.
      const attached = [];
      for (const entry of workspaces(task))
        if (entry.repository.strategy === 'attach') {
          const info = await inspectRepository(entry.repository);
          const owner = this.workspaceReservations.get(info.root);
          requireValue(
            !owner || owner === id,
            'This checkout is reserved by another task. Complete or cancel it first.',
            409,
          );
          attached.push(info.root);
        }
      if (signal.aborted) throw new Error('Execution cancelled');
      for (const root of attached)
        requireValue(
          !this.workspaceReservations.has(root) || this.workspaceReservations.get(root) === id,
          'This checkout is reserved by another task. Complete or cancel it first.',
          409,
        );
      for (const root of attached) this.workspaceReservations.set(root, id);
      for (const entry of workspaces(task)) {
        const view = workspaceView(task, entry);
        // Unique worktree identity even for repositories with related histories.
        view.id = workspaces(task).length > 1 ? `${id}-${workspaces(task).indexOf(entry)}` : id;
        if (!view.workspace)
          this.store.event(id, {
            type: 'workspace',
            repositoryId: entry.repository.id,
            summary: `${entry.repository.name}: preparing ${entry.repository.strategy === 'attach' ? 'attached checkout' : 'a new isolated task worktree'}…`,
          });
        await prepareWorkspace(
          view,
          this.store.directory,
          this.store.all().filter((t) => t.id !== id),
          {
            signal,
            checkpoint: () => {
              entry.baseCommit = view.baseCommit;
              task.status = this.store.get(id).status;
              task.messages = this.store.get(id).messages;
              this.store.save(task);
            },
            onLine: (line, stream) =>
              this.store.event(id, {
                type: 'transcript',
                stage: 'workspace',
                repositoryId: entry.repository.id,
                stream,
                text: line,
              }),
          },
        );
        for (const key of ['workspace', 'workspaceRoot', 'baseCommit', 'branch'])
          entry[key] = view[key];
        syncPrimary(task);
        if (!entry.workspaceAnnounced) {
          entry.workspaceAnnounced = true;
          this.store.event(id, {
            type: 'workspace',
            repositoryId: entry.repository.id,
            summary: `${entry.repository.name}: ${entry.repository.strategy === 'attach' ? 'Attached checkout' : 'Isolated task worktree'} ready`,
            details: `Branch: ${entry.branch}\nDirectory: ${entry.workspace}`,
          });
        }
        task.status = this.store.get(id).status;
        task.messages = this.store.get(id).messages;
        this.store.save(task);
        if (signal.aborted) throw new Error('Execution cancelled');
      }
      for (const entry of workspaces(task)) {
        if (!entry.setupCompleted) {
          for (const cmd of entry.repository.setup) {
            const result = await runProcess(cmd.command, cmd.args, {
              cwd: entry.workspace,
              signal,
              env: {
                RELAY_WORKSPACES_JSON: JSON.stringify(
                  Object.fromEntries(workspaces(task).map((e) => [e.repository.id, e.workspace])),
                ),
              },
              timeout: executionConfig(task, this.store.config).timeoutMinutes * 60000,
              onLine: (line, stream) =>
                this.store.event(id, {
                  type: 'transcript',
                  stage: 'setup',
                  repositoryId: entry.repository.id,
                  stream,
                  text: line,
                }),
            });
            if (result.code !== 0)
              throw new Error(
                `Setup failed for ${entry.repository.name}: ${cmd.command} exited ${result.code}`,
              );
          }
          if (signal.aborted) throw new Error('Execution cancelled');
          entry.setupCompleted = true;
          task.messages = this.store.get(id).messages;
          this.store.save(task);
        }
      }
    } else if (!task.workspace) {
      task.workspace = 'Demo workspace · no files changed';
      task.branch = `demo/${id.slice(0, 8)}`;
      task.baseCommit = 'simulated';
      this.store.save(task);
    }
    const stage = task.stage;
    const entries = workspaces(task);
    const scoped = entries.length > 1 && ['investigate', 'implement', 'review'].includes(stage);
    const entry = entries[scoped ? (task.repositoryCursor ?? 0) : 0];
    const view = { ...workspaceView(task, entry) };
    view.repositoryMap = entries.map((e) => ({
      repository: e.repository,
      workspace: e.workspace,
      workspaceRoot: e.workspaceRoot,
      branch: e.branch,
      baseCommit: e.baseCommit,
    }));
    view.activeRepositoryId = scoped ? entry.repository.id : null;
    const harness = stage === 'verify' ? 'checks' : task.routing[stage];
    const attempt = {
      id: randomUUID(),
      stage,
      harness,
      round: task.round,
      repositoryId: scoped ? entry.repository.id : null,
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
          : `${harness} is working on ${stage}${scoped ? ` · ${entry.repository.name}` : ''}.`,
    });
    const before = !task.demo ? await fingerprint(task) : 'demo';
    if (stage === 'review')
      requireValue(
        task.demo || task.verifiedFingerprint === before,
        'Workspace changed after verification. Request changes or rerun implementation before review.',
      );
    const otherBefore =
      stage === 'implement' && entries.length > 1
        ? await Promise.all(
            entries.filter((e) => e !== entry).map((e) => fingerprint(workspaceView(task, e))),
          )
        : null;
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
        for (const checkEntry of entries)
          for (const command of checkEntry.repository.checks) {
            const started = Date.now();
            const checkEvent = {
              type: 'activity',
              kind: 'tool',
              stage,
              harness: 'checks',
              repositoryId: checkEntry.repository.id,
              attemptId: attempt.id,
            };
            this.store.event(id, {
              ...checkEvent,
              summary: `Running check: ${command.command} ${command.args.join(' ')}`,
            });
            const result = await runProcess(command.command, command.args, {
              cwd: checkEntry.workspace,
              env: {
                RELAY_BASE_COMMIT: checkEntry.baseCommit,
                RELAY_REPOSITORY_ID: checkEntry.repository.id,
                RELAY_WORKSPACES_JSON: JSON.stringify(
                  Object.fromEntries(entries.map((e) => [e.repository.id, e.workspace])),
                ),
              },
              signal,
              timeout: executionConfig(task, this.store.config, stage).timeoutMinutes * 60000,
              onLine: (line, stream) =>
                this.store.event(id, {
                  type: 'transcript',
                  stage,
                  attemptId: attempt.id,
                  repositoryId: checkEntry.repository.id,
                  stream,
                  text: line.slice(0, 40000),
                }),
            });
            this.store.event(id, {
              ...checkEvent,
              summary: `Check ${result.code === 0 ? 'passed' : 'failed'}: ${command.command} ${command.args.join(' ')}`,
              details: `${result.stdout}\n${result.stderr}`.slice(-40000),
            });
            checks.push({
              repositoryId: checkEntry.repository.id,
              ...command,
              ...result,
              durationMs: Date.now() - started,
            });
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
        evidence: checks.map(
          (c) => `${c.repositoryId ?? 'demo'} · Exit ${c.code}: ${c.command} ${c.args.join(' ')}`,
        ),
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
        task: view,
        stage,
        harness,
        config: executionConfig(task, this.store.config, stage),
        directory: this.store.directory,
        attemptId: attempt.id,
        signal,
        onTerminal: (terminal) => {
          const current = this.store.get(id);
          const active = current.attempts.find((a) => a.id === attempt.id);
          active.terminal = terminal;
          this.store.save(current, {
            type: 'terminal',
            stage,
            harness,
            attemptId: attempt.id,
            summary: `${harness} terminal ready. Attach to watch; use Take over before editing.`,
            details: terminal.attachCommand,
          });
        },
        onEvent: (event) =>
          this.store.event(id, {
            ...event,
            stage,
            harness,
            repositoryId: entry.repository.id,
            attemptId: attempt.id,
          }),
      });
    }
    if (signal.aborted) throw new Error('Execution cancelled');
    const after = !task.demo ? await fingerprint(task) : 'demo';
    if (['triage', 'investigate', 'plan', 'review'].includes(stage) && before !== after)
      throw new Error(
        `${stage} modified the workspace despite being read-only. Inspect the diff before resuming.`,
      );
    if (otherBefore)
      requireValue(
        JSON.stringify(otherBefore) ===
          JSON.stringify(
            await Promise.all(
              entries.filter((e) => e !== entry).map((e) => fingerprint(workspaceView(task, e))),
            ),
          ),
        'Implementation modified another repository outside its assigned workspace. Inspect all diffs before resuming.',
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
    } else if (
      scoped &&
      handoff.verdict === 'complete' &&
      (stage !== 'review' || !handoff.findings.length) &&
      (task.repositoryCursor ?? 0) < entries.length - 1
    ) {
      task.repositoryCursor = (task.repositoryCursor ?? 0) + 1;
      task.status = 'queued';
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
      task.repositoryCursor = 0;
      task.stage = 'plan';
      task.status = 'queued';
    } else if (stage === 'plan') {
      task.status = 'awaiting_plan';
    } else if (stage === 'implement') {
      task.repositoryCursor = 0;
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
      repositoryId: scoped ? entry.repository.id : null,
      summary: scoped ? `${entry.repository.name}: ${handoff.summary}` : handoff.summary,
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
    task.repositoryCursor = 0;
    task.stage = 'implement';
    task.reviewedFingerprint = null;
    if (task.round > (task.execution?.maxRepairRounds ?? this.store.config.maxRepairRounds)) {
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
    for (const run of this.manualRuns.values()) run.controller.abort();
    while (this.running.size || this.manualRuns.size) await delay(25);
  }
}
