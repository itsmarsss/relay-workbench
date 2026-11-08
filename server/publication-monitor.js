import { feedbackItems } from './feedback-autopilot.js';
import { saveDeliveryRun } from './delivery-runs.js';
import { randomUUID } from 'node:crypto';
import { executeHarness } from './harness.js';
import { requireValue, executionConfig } from './domain.js';
import { workspaces, workspaceView } from './task-repositories.js';
import { fingerprint } from './workspace.js';

export function publicationSnapshot(raw) {
  requireValue(raw && typeof raw === 'object', 'Monitor returned no publication snapshot');
  for (const [key, allowed] of Object.entries({
    state: ['unknown', 'not_created', 'open', 'closed', 'merged'],
    checks: ['unknown', 'pending', 'passing', 'failing'],
    review: ['unknown', 'required', 'approved', 'changes_requested'],
  }))
    requireValue(allowed.includes(raw[key]), `Invalid publication ${key}`);
  for (const key of ['url', 'number', 'title'])
    requireValue(
      typeof raw[key] === 'string' && raw[key].length <= 2000,
      `Invalid publication ${key}`,
    );
  requireValue(raw.draft === null || typeof raw.draft === 'boolean', 'Invalid draft status');
  if (raw.url) {
    const url = new URL(raw.url);
    requireValue(
      ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password,
      'Invalid PR URL',
    );
  }
  requireValue(
    !['open', 'closed', 'merged'].includes(raw.state) || raw.url,
    'An observed PR needs its verified URL',
  );
  return Object.fromEntries(
    ['url', 'number', 'title', 'state', 'draft', 'checks', 'review'].map((k) => [k, raw[k]]),
  );
}

export function observationDelay({ failures = 0, unchanged = 0 } = {}) {
  return Math.min(15 * 60000, 5 * 60000 * 2 ** Math.min(4, failures ? failures - 1 : unchanged));
}

export class PublicationMonitor {
  constructor(
    store,
    {
      observe = executeHarness,
      now = () => Date.now(),
      isWorkspaceBusy = () => false,
      onFeedback = async () => {},
    } = {},
  ) {
    this.onFeedback = onFeedback;
    this.store = store;
    this.observe = observe;
    this.now = now;
    this.isWorkspaceBusy = isWorkspaceBusy;
    this.running = new Map();
    for (const task of store.all()) {
      let changed = false;
      for (const entry of workspaces(task))
        if (entry.publicationMonitor?.status === 'running') {
          Object.assign(entry.publicationMonitor, {
            status: 'interrupted',
            nextAt: new Date(now() + 30000).toISOString(),
          });
          changed = true;
        }
      if (changed) {
        for (const entry of workspaces(task)) saveDeliveryRun(task, entry, 'monitor');
        store.save(task);
      }
    }
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref();
  }
  update(id, repositoryId, apply, event) {
    const task = this.store.get(id);
    const entry = workspaces(task).find((e) => e.repository.id === repositoryId);
    apply(entry, task);
    this.store.save(task, event);
    return entry;
  }
  configure(id, repositoryId, enabled) {
    const task = this.store.get(id);
    requireValue(
      task?.status === 'completed' && !task.demo,
      'Accept a live task before monitoring publication',
      409,
    );
    const entry = workspaces(task).find((e) => e.repository.id === repositoryId);
    requireValue(entry, 'Select a task repository');
    requireValue(entry.submission?.status !== 'running', 'Wait for submission to finish', 409);
    const key = `${id}:${repositoryId}`;
    if (!enabled) this.running.get(key)?.controller.abort();
    this.update(
      id,
      repositoryId,
      (e) => {
        e.publicationMonitor = {
          ...e.publicationMonitor,
          enabled,
          status: enabled ? 'queued' : 'paused',
          failures: 0,
          unchanged: 0,
          nextAt: new Date(this.now()).toISOString(),
        };
      },
      {
        type: 'publication',
        summary: enabled
          ? `PR status monitoring enabled for ${entry.repository.name}.`
          : `PR status monitoring paused for ${entry.repository.name}.`,
      },
    );
    this.tick();
    return this.store.get(id);
  }
  taskBusy(task) {
    return workspaces(task).some(
      (entry) =>
        entry.delivery?.status === 'running' ||
        entry.submission?.status === 'running' ||
        (entry.workspaceRoot && this.isWorkspaceBusy(entry.workspaceRoot)),
    );
  }
  tick() {
    if (this.suspended || this.running.size) return;
    const candidates = this.store.all().flatMap((task) =>
      task.status === 'completed' && !this.taskBusy(task)
        ? workspaces(task)
            .filter(
              (entry) =>
                entry.publicationMonitor?.enabled &&
                !(Date.parse(entry.publicationMonitor.nextAt) > this.now()),
            )
            .map((entry) => ({ task, entry }))
        : [],
    );
    candidates.sort(
      (a, b) =>
        (Date.parse(a.entry.publicationMonitor.nextAt) || 0) -
        (Date.parse(b.entry.publicationMonitor.nextAt) || 0),
    );
    const next = candidates[0];
    if (!next) return;
    const { task, entry } = next;
    const key = `${task.id}:${entry.repository.id}`;
    const controller = new AbortController();
    const run = { controller };
    this.running.set(key, run);
    run.done = this.run(task, entry, controller.signal)
      .catch(() => {})
      .finally(() => this.running.delete(key));
  }
  updateRun(id, repositoryId, apply, event) {
    return this.update(
      id,
      repositoryId,
      (entry, task) => {
        apply(entry, task);
        saveDeliveryRun(task, entry, 'monitor');
        if (event)
          Object.assign(event, {
            stage: 'monitor',
            attemptId: entry.publicationMonitor.attemptId,
            repositoryId,
            harness: entry.publicationMonitor.harness,
          });
      },
      event,
    );
  }
  async run(task, entry, signal) {
    const id = task.id,
      repositoryId = entry.repository.id,
      attemptId = randomUUID();
    const view = workspaceView(task, entry);
    const publishedCommit =
      entry.delivery?.status === 'complete' && entry.delivery?.phase === 'monitoring'
        ? entry.delivery.commit
        : undefined;
    const harness = task.routing.investigate;
    const startedAt = new Date(this.now()).toISOString();
    this.updateRun(
      id,
      repositoryId,
      (e) => {
        Object.assign(e.publicationMonitor, {
          status: 'running',
          startedAt,
          attemptId,
          harness,
          terminal: undefined,
          sessionId: undefined,
          finishedAt: undefined,
          summary: 'Checking PR status',
          details: '',
          evidence: [],
          error: null,
          model: executionConfig(task, this.store.config, 'investigate').harnesses[harness]?.model,
        });
      },
      { type: 'publication', summary: `Checking PR status for ${entry.repository.name}.` },
    );
    let before;
    try {
      requireValue(
        this.store.config.harnesses[harness]?.enabled,
        'The configured monitoring harness is unavailable',
      );
      before = await fingerprint(view);
      const result = await this.observe({
        task: {
          ...view,
          debugContext: undefined,
          verificationContext: undefined,
          publicationContext: {
            repository: entry.repository.name,
            branch: entry.branch,
            commit: publishedCommit ?? entry.submission?.commit,
            submission: entry.submission
              ? {
                  status: entry.submission.status,
                  commit: entry.submission.commit,
                  stdout: entry.submission.stdout?.slice(-12000),
                  stderr: entry.submission.stderr?.slice(-12000),
                  error: entry.submission.error,
                }
              : null,
            feedbackEnabled: entry.feedbackAutopilot?.enabled === true,
            previous: entry.publication,
            checkedAt: entry.publication?.checkedAt,
          },
        },
        stage: 'monitor',
        harness,
        directory: this.store.directory,
        attemptId,
        signal,
        config: { ...executionConfig(task, this.store.config, 'investigate'), timeoutMinutes: 2 },
        onEvent: (event) =>
          this.store.event(id, { ...event, stage: 'monitor', harness, repositoryId, attemptId }),
        onTerminal: (terminal) =>
          this.updateRun(id, repositoryId, (e) => {
            e.publicationMonitor.terminal = terminal;
          }),
        onSession: (sessionId) =>
          this.updateRun(id, repositoryId, (e) => {
            e.publicationMonitor.sessionId = sessionId;
          }),
      });
      requireValue(!signal.aborted, 'Monitoring paused');
      requireValue(
        !this.taskBusy(this.store.get(id)),
        'Workspace became busy; PR observation deferred',
      );
      requireValue(
        before === (await fingerprint(view)),
        'Monitor changed the workspace; inspect it before any further action',
      );
      requireValue(
        result.verdict === 'complete',
        result.summary || 'Monitor could not observe publication status',
      );
      const feedback = feedbackItems(result.feedback ?? []);
      const snapshot = publicationSnapshot(result.publication);
      requireValue(result.evidence?.length, 'Publication status needs observed evidence');
      const previous = this.store.get(id);
      const old = workspaces(previous).find((e) => e.repository.id === repositoryId).publication;
      const changed = JSON.stringify(old && publicationSnapshot(old)) !== JSON.stringify(snapshot);
      this.updateRun(
        id,
        repositoryId,
        (e) => {
          const failures =
            snapshot.state === 'unknown' ? (e.publicationMonitor.failures ?? 0) + 1 : 0;
          if (
            e.feedbackAutopilot?.current?.state === 'publishing' &&
            ['open', 'merged'].includes(snapshot.state) &&
            e.delivery?.status === 'complete'
          ) {
            e.feedbackAutopilot.current.state = 'complete';
            const record = e.feedbackAutopilot.history.find(
              (r) => r.id === e.feedbackAutopilot.current.id,
            );
            if (record) record.state = 'complete';
          }
          if (snapshot.state !== 'unknown' || !e.publication || e.publication.state === 'unknown')
            e.publication = {
              ...snapshot,
              summary: result.summary.slice(0, 1000),
              details: result.details.slice(0, 20000),
              evidence: result.evidence.slice(0, 20),
              checkedAt: new Date(this.now()).toISOString(),
            };
          const unchanged = changed ? 0 : (e.publicationMonitor.unchanged ?? 0) + 1;
          Object.assign(e.publicationMonitor, {
            unchanged,
            status: snapshot.state === 'unknown' ? 'unavailable' : 'idle',
            summary: result.summary,
            details: result.details,
            evidence: result.evidence,
            finishedAt: new Date(this.now()).toISOString(),
            failures,
            enabled: !['merged', 'closed'].includes(snapshot.state) && failures < 3,
            nextAt: new Date(this.now() + observationDelay({ failures, unchanged })).toISOString(),
            error: snapshot.state === 'unknown' ? result.summary.slice(0, 1000) : null,
          });
        },
        changed
          ? {
              type: 'publication',
              observationChange: true,
              summary: result.summary,
              details: result.details,
              repositoryId,
            }
          : undefined,
      );
      await this.onFeedback(id, repositoryId, feedback);
    } catch (error) {
      if (!signal.aborted && this.taskBusy(this.store.get(id))) {
        this.updateRun(id, repositoryId, (e) =>
          Object.assign(e.publicationMonitor, {
            status: 'idle',
            summary: 'PR observation deferred while the workspace is in use.',
            finishedAt: new Date(this.now()).toISOString(),
            nextAt: new Date(this.now() + 30000).toISOString(),
          }),
        );
        return;
      }
      const mutated = before && before !== (await fingerprint(view).catch(() => before));
      if (mutated)
        error = new Error(
          'Monitor changed the workspace; monitoring stopped. Inspect the changes before further action.',
        );
      this.updateRun(
        id,
        repositoryId,
        (e) => {
          const failures = (e.publicationMonitor.failures ?? 0) + 1;
          Object.assign(e.publicationMonitor, {
            status: signal.aborted ? 'paused' : 'unavailable',
            summary: error.message,
            finishedAt: new Date(this.now()).toISOString(),
            enabled: !mutated && !signal.aborted && failures < 3,
            failures,
            error: error.message.slice(0, 2000),
            nextAt: new Date(this.now() + observationDelay({ failures })).toISOString(),
          });
        },
        {
          type: 'publication',
          observationChange: true,
          summary: `PR status unavailable: ${error.message}`,
          repositoryId,
        },
      );
    }
  }
  async stop() {
    clearInterval(this.timer);
    for (const run of this.running.values()) run.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }
}
