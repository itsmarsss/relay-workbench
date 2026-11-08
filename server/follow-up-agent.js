import { randomUUID } from 'node:crypto';
import { HARNESSES, requireValue, text, executionConfig, validateHandoff } from './domain.js';
import { executeHarness } from './harness.js';
import { workspaces } from './task-repositories.js';
import { fingerprint, git } from './workspace.js';
import { questionContext } from './side-questions.js';

// A real harness run, separate from read-only side questions and stage approvals.
export class FollowUpAgent {
  constructor(store, engine, monitor, { run = executeHarness } = {}) {
    this.store = store;
    this.engine = engine;
    this.monitor = monitor;
    this.run = run;
    this.running = new Map();
    this.stopping = false;
    for (const task of store.all()) {
      let changed = false;
      for (const run of task.deliveryRuns ?? [])
        if (run.stage === 'followup' && run.status === 'running') {
          run.status = 'interrupted';
          run.error = 'Relay restarted. Inspect the saved run before retrying.';
          run.finishedAt = new Date().toISOString();
          changed = true;
        }
      if (changed) store.save(task);
    }
  }
  update(id, runId, apply, event) {
    const task = this.store.get(id);
    const run = task.deliveryRuns.find((run) => run.id === runId);
    apply(run);
    this.store.save(
      task,
      event ? { ...event, stage: 'followup', attemptId: runId, harness: run.harness } : undefined,
    );
  }
  async start(id, { message, provider } = {}) {
    requireValue(!this.stopping, 'Relay is shutting down', 409);
    const task = this.store.get(id);
    requireValue(
      task?.status === 'completed' && !task.demo,
      'Finish the workflow before continuing work',
      409,
    );
    const request = text(message, 'Follow-up request', 20000);
    provider ??= task.routing.implement;
    requireValue(
      HARNESSES.includes(provider) && this.store.config.harnesses[provider]?.enabled,
      'Choose an enabled agent provider',
    );
    requireValue(
      !this.running.has(id) && !this.engine.actionLocks.has(id),
      'A follow-up is already starting or running',
      409,
    );
    const entries = workspaces(task),
      roots = [...new Set(entries.map((entry) => entry.workspaceRoot))];
    requireValue(
      entries.every((entry) => entry.workspace && entry.workspaceRoot && !entry.cleanedWorkspace),
      'The retained workspace is unavailable. Create a new task.',
      409,
    );
    for (const entry of entries) {
      requireValue(
        !this.engine.workspaceReservations.has(entry.workspaceRoot),
        'Another process owns this workspace',
        409,
      );
      requireValue(
        (await git(entry.workspaceRoot, ['branch', '--show-current'])) === entry.branch,
        'Workspace branch changed. Inspect it before continuing.',
        409,
      );
    }
    const before = await fingerprint(task);
    requireValue(
      !this.stopping &&
        !this.running.has(id) &&
        !this.engine.actionLocks.has(id) &&
        roots.every((root) => !this.engine.workspaceReservations.has(root)),
      'The workspace became busy',
      409,
    );
    const record = {
      id: randomUUID(),
      stage: 'followup',
      role: 'followup',
      auxiliary: true,
      harness: provider,
      status: 'running',
      startedAt: new Date().toISOString(),
      request,
      parentAttemptId: task.deliveryRuns?.at(-1)?.id ?? task.attempts.at(-1)?.id,
      relation: 'Continue work',
      memorySnapshot: questionContext(this.store, task).memorySnapshot,
    };
    const observed = entries
      .filter((entry) => entry.publicationMonitor?.enabled)
      .map((entry) => entry.repository.id);
    for (const entry of entries)
      if (entry.publicationMonitor) this.monitor.configure(id, entry.repository.id, false);
    for (const root of roots) this.engine.workspaceReservations.set(root, id);
    const current = this.store.get(id);
    (current.deliveryRuns ??= []).push(record);
    this.store.save(current, {
      type: 'stage_started',
      stage: 'followup',
      attemptId: record.id,
      harness: provider,
      summary: 'Follow-up agent started.',
      details: request,
    });
    const controller = new AbortController(),
      active = { controller, done: null };
    this.running.set(id, active);
    const release = () => {
      for (const root of roots)
        if (this.engine.workspaceReservations.get(root) === id)
          this.engine.workspaceReservations.delete(root);
    };
    active.done = (async () => {
      const input = {
        ...task,
        followUpRequest: request,
        followUpSnapshot: questionContext(this.store, task),
        memorySnapshot: record.memorySnapshot,
        repositoryMap: entries.map((entry) => ({
          ...entry.repository,
          workspace: entry.workspace,
          workspaceRoot: entry.workspaceRoot,
          branch: entry.branch,
          baseCommit: entry.baseCommit,
        })),
      };
      const result = validateHandoff(
        await this.run({
          task: input,
          stage: 'followup',
          harness: provider,
          config: executionConfig(task, this.store.config, 'followup'),
          directory: this.store.directory,
          attemptId: record.id,
          signal: controller.signal,
          onEvent: (event) => this.update(id, record.id, () => {}, event),
          onTerminal: (terminal) =>
            this.update(id, record.id, (run) => {
              run.terminal = terminal;
            }),
          onSession: (sessionId) =>
            this.update(id, record.id, (run) => {
              run.sessionId = sessionId;
            }),
          onModel: (model) =>
            this.update(id, record.id, (run) => {
              run.actualModel = model;
            }),
        }),
        'followup',
      );
      requireValue(
        !controller.signal.aborted,
        'Follow-up stopped. Inspect its saved activity before retrying.',
      );
      requireValue(
        (await fingerprint(this.store.get(id))) === before,
        'Follow-up changed local source before approval. Changes are preserved; inspect and reverify them before continuing.',
      );
      this.update(
        id,
        record.id,
        (run) => {
          run.status = result.verdict === 'complete' ? 'complete' : 'blocked';
          run.handoff = result;
          run.finishedAt = new Date().toISOString();
        },
        { type: 'handoff', summary: result.summary, details: result.details },
      );
      if (result.verdict === 'complete' && result.followUpAction === 'changes') {
        release();
        await this.engine.action(id, 'follow-up', { message: request, provider });
      }
    })()
      .catch((error) =>
        this.update(
          id,
          record.id,
          (run) => {
            run.status = controller.signal.aborted ? 'interrupted' : 'failed';
            run.error = error.message;
            run.finishedAt = new Date().toISOString();
          },
          { type: 'error', summary: 'Follow-up needs attention.', details: error.message },
        ),
      )
      .finally(() => {
        release();
        this.running.delete(id);
        const latest = this.store.get(id);
        if (!this.stopping && latest.status === 'completed')
          for (const repositoryId of observed) this.monitor.configure(id, repositoryId, true);
      });
    return record;
  }
  async pause(id) {
    const run = this.running.get(id);
    requireValue(run, 'No follow-up agent is running', 409);
    run.controller.abort();
    await run.done;
  }
  async stop() {
    this.stopping = true;
    for (const run of this.running.values()) run.controller.abort();
    await Promise.all([...this.running.values()].map((run) => run.done));
  }
}
