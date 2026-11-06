import { randomUUID, createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { executeHarness } from './harness.js';
import { requireValue, executionConfig } from './domain.js';
import { git, fingerprint } from './workspace.js';
import { workspaces, workspaceView } from './task-repositories.js';
import { publicationSnapshot } from './publication-monitor.js';

// Stable across committing/staging the same content; inspects only changed paths.
export async function acceptedContent(view) {
  const paths = new Set(
    (
      await git(view.workspaceRoot, ['diff', '--name-only', '-z', view.baseCommit, '--'], {
        raw: true,
      })
    )
      .split('\0')
      .filter(Boolean),
  );
  for (const path of (
    await git(view.workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z'], {
      raw: true,
    })
  )
    .split('\0')
    .filter(Boolean))
    paths.add(path);
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    try {
      const file = join(view.workspaceRoot, path),
        stat = await lstat(file);
      requireValue(
        stat.isFile() && stat.size <= 16 * 1024 * 1024,
        'Changed publication files must be inspectable regular files',
      );
      const contents = await readFile(file);
      hash.update(JSON.stringify([path, stat.mode & 0o111, contents.length]));
      hash.update(contents);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update(JSON.stringify([path, 'deleted']));
    }
  }
  return hash.digest('hex');
}
export class PublicationWorkflow {
  constructor(store, engine, monitor, { publish = executeHarness } = {}) {
    this.store = store;
    this.engine = engine;
    this.monitor = monitor;
    this.publish = publish;
    this.running = new Map();
    for (const task of store.all()) {
      let changed = false;
      for (const entry of workspaces(task))
        if (entry.delivery?.status === 'running') {
          Object.assign(entry.delivery, {
            status: 'interrupted',
            summary:
              'Publication interrupted. The agent must inspect remote state before retrying.',
            finishedAt: new Date().toISOString(),
          });
          changed = true;
        }
      if (changed) store.save(task);
    }
  }
  update(id, repoId, apply, event) {
    const task = this.store.get(id),
      entry = workspaces(task).find((e) => e.repository.id === repoId);
    apply(entry, task);
    this.store.save(task, event);
    return task;
  }
  async start(id, repositoryId) {
    const task = this.store.get(id);
    requireValue(
      task?.status === 'completed' && !task.demo,
      'Accept a live task before publishing',
      409,
    );
    const entry = workspaces(task).find((e) => e.repository.id === repositoryId);
    requireValue(entry, 'Select a task repository');
    requireValue(
      !this.running.has(id) && entry.submission?.status !== 'running',
      'Publication is already running',
      409,
    );
    const view = workspaceView(task, entry);
    requireValue(
      !this.engine.workspaceReservations.has(view.workspaceRoot),
      'Another task owns this workspace',
      409,
    );
    requireValue(
      !entry.delivery?.requiresReverification,
      'Publication changed accepted source or history; reverify before retrying',
      409,
    );
    const content = await acceptedContent(view);
    const head = await git(view.workspaceRoot, ['rev-parse', 'HEAD']);
    const priorCommit = entry.delivery?.commit ?? entry.submission?.commit;
    const resumableCommit =
      entry.delivery?.content === content &&
      entry.delivery?.originalHead &&
      (await git(view.workspaceRoot, [
        'merge-base',
        '--is-ancestor',
        entry.delivery.originalHead,
        'HEAD',
      ]).then(
        () => true,
        () => false,
      ));
    requireValue(
      (await fingerprint(view)) === (entry.acceptedFingerprint ?? task.reviewedFingerprint) ||
        ((head === priorCommit || resumableCommit) &&
          !(await git(view.workspaceRoot, ['status', '--porcelain', '--untracked-files=normal']))),
      'Workspace changed since acceptance; reverify before publishing',
      409,
    );
    requireValue(
      (await git(view.workspaceRoot, ['branch', '--show-current'])) === entry.branch,
      'Publication branch changed; inspect the workspace',
      409,
    );
    requireValue(
      !this.running.has(id) && !this.engine.workspaceReservations.has(view.workspaceRoot),
      'Workspace became busy',
      409,
    );
    this.monitor.configure(id, repositoryId, false);
    this.engine.workspaceReservations.set(view.workspaceRoot, id);
    const controller = new AbortController(),
      run = { controller, root: view.workspaceRoot };
    this.running.set(id, run);
    const previous = entry.delivery;
    this.update(
      id,
      repositoryId,
      (e) => {
        e.delivery = {
          id: randomUUID(),
          status: 'running',
          phase: 'publishing',
          harness: task.routing.implement,
          startedAt: new Date().toISOString(),
          summary: 'The publication agent is inspecting the accepted branch and remote state.',
          content,
          originalHead: head,
          previous: previous
            ? {
                status: previous.status,
                summary: previous.summary,
                nextAction: previous.nextAction,
                commit: previous.commit,
              }
            : null,
        };
      },
      {
        type: 'publication',
        summary: `Publication agent started for ${entry.repository.name}.`,
        repositoryId,
      },
    );
    run.done = this.run(task, entry, content, head, controller.signal).finally(() => {
      this.running.delete(id);
      if (this.engine.workspaceReservations.get(view.workspaceRoot) === id)
        this.engine.workspaceReservations.delete(view.workspaceRoot);
    });
    run.done.catch(() => {});
    return this.store.get(id);
  }
  async run(task, entry, content, originalHead, signal) {
    const id = task.id,
      repoId = entry.repository.id,
      view = workspaceView(task, entry);
    const record = workspaces(this.store.get(id)).find((e) => e.repository.id === repoId).delivery;
    try {
      await Promise.allSettled(
        [...this.monitor.running.entries()]
          .filter(([key]) => key === `${id}:${repoId}`)
          .map(([, r]) => r.done),
      );
      const config = executionConfig(task, this.store.config, 'implement');
      requireValue(
        config.harnesses[task.routing.implement]?.enabled,
        'Publication harness is unavailable',
      );
      const result = await this.publish({
        task: {
          ...view,
          debugContext: undefined,
          verificationContext: undefined,
          publicationContext: {
            branch: entry.branch,
            baseCommit: entry.baseCommit,
            acceptedContent: content,
            originalHead,
            submission: entry.submission
              ? {
                  ...entry.submission,
                  stdout: entry.submission.stdout?.slice(-12000),
                  stderr: entry.submission.stderr?.slice(-12000),
                }
              : null,
            previous: record.previous,
            providerHint: entry.repository.prCommand,
            expectedDraft: true,
          },
        },
        stage: 'publish',
        harness: task.routing.implement,
        config: { ...config, timeoutMinutes: 10 },
        directory: this.store.directory,
        attemptId: record.id,
        signal,
        onEvent: (event) => {
          this.store.event(id, {
            ...event,
            stage: 'publish',
            harness: task.routing.implement,
            repositoryId: repoId,
            attemptId: record.id,
          });
          if (event.type === 'activity' && event.kind === 'message')
            this.update(id, repoId, (e) => {
              e.delivery.summary = event.summary.slice(0, 400);
            });
        },
        onTerminal: (terminal) =>
          this.update(id, repoId, (e) => {
            e.delivery.terminal = terminal;
          }),
        onSession: (sessionId) =>
          this.update(id, repoId, (e) => {
            e.delivery.sessionId = sessionId;
          }),
      });
      requireValue(!signal.aborted, 'Publication stopped; inspect remote state before retrying');
      requireValue(
        (await acceptedContent(view)) === content &&
          (await git(view.workspaceRoot, ['branch', '--show-current'])) === entry.branch,
        'Accepted source or branch changed during publication; reverify before continuing',
      );
      await git(view.workspaceRoot, ['merge-base', '--is-ancestor', originalHead, 'HEAD']);
      const commit = await git(view.workspaceRoot, ['rev-parse', 'HEAD']);
      const complete = result.verdict === 'complete';
      const publication = publicationSnapshot(result.publication);
      if (complete) {
        requireValue(
          ['open', 'merged', 'closed'].includes(publication.state) &&
            publication.url &&
            result.evidence?.length,
          'Publication needs a verified remote PR and evidence',
        );
        requireValue(
          !(await git(view.workspaceRoot, ['status', '--porcelain', '--untracked-files=normal'])),
          'Accepted changes are not fully committed',
        );
      }
      this.update(
        id,
        repoId,
        (e) => {
          Object.assign(e.delivery, {
            status: complete ? 'complete' : 'blocked',
            phase: complete ? 'monitoring' : 'needs_attention',
            summary: result.summary,
            details: result.details,
            evidence: result.evidence,
            nextAction: result.risks?.join('\n') || result.details,
            options: result.options,
            commit,
            finishedAt: new Date().toISOString(),
          });
          if (publication.url)
            e.publication = {
              ...publication,
              summary: result.summary,
              evidence: result.evidence,
              checkedAt: new Date().toISOString(),
            };
        },
        {
          type: 'publication',
          summary: result.summary,
          details: result.details,
          repositoryId: repoId,
        },
      );
      if (complete) this.monitor.configure(id, repoId, true);
    } catch (error) {
      const currentContent = await acceptedContent(view).catch(() => null);
      const historySafe = await git(view.workspaceRoot, [
        'merge-base',
        '--is-ancestor',
        originalHead,
        'HEAD',
      ]).then(
        () => true,
        () => false,
      );
      const branchSafe = await git(view.workspaceRoot, ['branch', '--show-current']).then(
        (branch) => branch === entry.branch,
        () => false,
      );
      const commit =
        currentContent === content && historySafe && branchSafe
          ? await git(view.workspaceRoot, ['rev-parse', 'HEAD']).catch(() => null)
          : null;
      this.update(
        id,
        repoId,
        (e) =>
          Object.assign(e.delivery, {
            status: 'blocked',
            requiresReverification: currentContent !== content || !historySafe || !branchSafe,
            phase: 'needs_attention',
            summary: 'Publication needs attention.',
            details: error.message,
            nextAction: error.message,
            commit,
            finishedAt: new Date().toISOString(),
          }),
        {
          type: 'publication',
          summary: `Publication stopped: ${error.message}`,
          repositoryId: repoId,
        },
      );
    }
  }
  pause(id) {
    const run = this.running.get(id);
    requireValue(run, 'No publication agent is running', 409);
    run.controller.abort();
    const task = this.store.get(id);
    const entry = workspaces(task).find((e) => e.delivery?.status === 'running');
    if (entry)
      this.update(
        id,
        entry.repository.id,
        (e) => {
          e.delivery.stopRequested = true;
        },
        {
          type: 'publication',
          summary: 'Stopping publication. Remote state will be inspected before any retry.',
        },
      );
    return this.store.get(id);
  }
  async stop() {
    for (const run of this.running.values()) run.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }
}
