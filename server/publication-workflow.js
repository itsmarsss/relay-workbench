import { requireAutomationAuthorization } from './workflow-automation.js';
import { requirePublicationPrerequisites } from './publication-prerequisites.js';
import { publicationEvidence, PUBLICATION_CHECK_SCOPE } from './publication-evidence.js';
import { memoryContext } from './memory.js';
import {
  prepareCheckRunner,
  readCheckJournal,
  verificationSignature,
} from './verification-evidence.js';
import { validateVerification } from './verification.js';
import { saveDeliveryRun, recoverDeliveryRuns } from './delivery-runs.js';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeHarness } from './harness.js';
import { requireValue, executionConfig, text } from './domain.js';
import { git, fingerprint } from './workspace.js';
import { workspaces, workspaceView, syncPrimary } from './task-repositories.js';
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
  constructor(
    store,
    engine,
    monitor,
    { publish = executeHarness, validate = executeHarness, memory = memoryContext } = {},
  ) {
    this.store = store;
    this.engine = engine;
    this.monitor = monitor;
    this.publish = publish;
    this.validate = validate;
    this.memory = memory;
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
      changed =
        recoverDeliveryRuns(task, store.events?.(task.id, 0, 100000) ?? [], workspaces(task)) ||
        changed;
      if (changed) store.save(task);
    }
  }
  update(id, repoId, apply, event) {
    const task = this.store.get(id),
      entry = workspaces(task).find((e) => e.repository.id === repoId);
    saveDeliveryRun(task, entry, 'publish');
    apply(entry, task);
    saveDeliveryRun(task, entry, 'publish');
    this.store.save(
      task,
      event
        ? {
            ...event,
            stage: entry.delivery?.stage ?? 'publish',
            attemptId: entry.delivery?.id,
            repositoryId: repoId,
            harness: entry.delivery?.harness,
          }
        : undefined,
    );
    return task;
  }
  async start(id, repositoryId, { request, automation } = {}) {
    requireValue(!this.engine.actionLocks?.has(id), 'Another workflow action is in progress', 409);
    let followUpRequest =
      request === undefined ? undefined : text(request, 'PR update request', 20000);
    const task = this.store.get(id);
    requireValue(
      task?.status === 'completed' && !task.demo,
      'Accept a live task before publishing',
      409,
    );
    const entry = workspaces(task).find((e) => e.repository.id === repositoryId);
    requireValue(entry, 'Select a task repository');
    requirePublicationPrerequisites(task, repositoryId);
    if (request === undefined && ['blocked', 'interrupted'].includes(entry.delivery?.status))
      followUpRequest = entry.delivery.followUpRequest;
    requireValue(
      !followUpRequest || entry.publication?.state === 'open',
      'Publish an open PR before requesting metadata updates',
      409,
    );
    requireValue(
      !this.running.has(id) && entry.submission?.status !== 'running',
      'Publication is already running',
      409,
    );
    const view = workspaceView(task, entry);
    if (followUpRequest)
      requireValue(
        !(await git(view.workspaceRoot, ['status', '--porcelain', '--untracked-files=normal'])),
        'Finish and publish accepted source changes before requesting PR metadata updates',
        409,
      );
    requireValue(
      !this.engine.workspaceReservations.has(view.workspaceRoot),
      'Another task owns this workspace',
      409,
    );
    const ownedPreparation =
      entry.delivery?.approvalBaseline &&
      entry.delivery?.workingFingerprint === (await fingerprint(view));
    requireValue(
      !entry.delivery?.requiresReverification || ownedPreparation,
      'Workspace changed outside publication; inspect it before retrying',
      409,
    );
    const content =
      ownedPreparation && entry.delivery.requiresReverification
        ? entry.delivery.content
        : await acceptedContent(view);
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
      ownedPreparation ||
        (await fingerprint(view)) === (entry.acceptedFingerprint ?? task.reviewedFingerprint) ||
        ((head === priorCommit || resumableCommit) &&
          !(await git(view.workspaceRoot, ['status', '--porcelain', '--untracked-files=normal']))),
      'Workspace changed since acceptance; reverify before publishing',
      409,
    );
    requireValue(
      (await git(view.workspaceRoot, ['branch', '--show-current'])) === entry.branch ||
        (ownedPreparation && entry.delivery.requiresReverification),
      'Publication branch changed; inspect the workspace',
      409,
    );
    requireValue(
      !this.running.has(id) && !this.engine.workspaceReservations.has(view.workspaceRoot),
      'Workspace became busy',
      409,
    );
    requireAutomationAuthorization(this.store, id, automation, 'draft_pr');
    this.monitor.configure(id, repositoryId, false);
    const roots = [...new Set(workspaces(task).map((e) => e.workspaceRoot))];
    requireValue(
      roots.every((root) => !this.engine.workspaceReservations.has(root)),
      'Another task owns a related workspace',
      409,
    );
    for (const root of roots) this.engine.workspaceReservations.set(root, id);
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
          automation,
          phase: 'publishing',
          harness: task.routing.implement,
          startedAt: new Date().toISOString(),
          summary: 'The publication agent is inspecting the accepted branch and remote state.',
          model: executionConfig(task, this.store.config, 'implement').harnesses[
            task.routing.implement
          ]?.model,
          content,
          originalHead: head,
          requiresReverification: previous?.requiresReverification,
          approvalBaseline: previous?.approvalBaseline,
          workingFingerprint: previous?.workingFingerprint,
          stage: 'publish',
          followUpRequest,
          auxiliary: true,
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
        summary: `${followUpRequest ? 'PR update' : 'Publication'} agent started for ${entry.repository.name}.`,
        ...(followUpRequest ? { details: followUpRequest } : {}),
        repositoryId,
      },
    );
    run.done = this.run(task, entry, content, head, controller.signal).finally(() => {
      this.running.delete(id);
      for (const root of roots)
        if (this.engine.workspaceReservations.get(root) === id)
          this.engine.workspaceReservations.delete(root);
    });
    run.done.catch(() => {});
    return this.store.get(id);
  }
  async invoke(
    task,
    entry,
    signal,
    context,
    { stage = 'publish', verificationContext, first = false } = {},
  ) {
    requireValue(!signal.aborted, 'Publication stopped');
    const routingStage = stage === 'review' ? 'review' : 'implement';
    const harness = task.routing[routingStage];
    const config = executionConfig(task, this.store.config, routingStage);
    requireValue(config.harnesses[harness]?.enabled, `${harness} is unavailable`);
    const current = workspaces(this.store.get(task.id)).find(
      (e) => e.repository.id === entry.repository.id,
    ).delivery;
    if (!first)
      this.update(task.id, entry.repository.id, (e) => {
        const previous = e.delivery;
        e.delivery = {
          ...previous,
          id: randomUUID(),
          stage,
          auxiliary: true,
          phase:
            stage === 'publish'
              ? (context.phase ?? 'publishing')
              : stage === 'verify'
                ? 'verifying'
                : 'reviewing',
          harness,
          model: config.harnesses[harness].model,
          actualModel: undefined,
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: undefined,
          terminal: undefined,
          sessionId: undefined,
          summary:
            stage === 'verify'
              ? 'Verifying the prepared branch.'
              : stage === 'review'
                ? 'Reviewing branch preparation against the accepted change.'
                : 'Preparing publication.',
          parentAttemptId: previous.id,
          handoff: undefined,
          details: undefined,
          evidence: [],
          nextAction: undefined,
          options: [],
        };
      });
    const record = first
      ? current
      : workspaces(this.store.get(task.id)).find((e) => e.repository.id === entry.repository.id)
          .delivery;
    const memorySnapshot = this.memory(
      this.store,
      task,
      workspaces(task).map((e) => e.repository.id),
    );
    this.update(task.id, entry.repository.id, (e) => {
      e.delivery.memorySnapshot = memorySnapshot;
      if (verificationContext?.runner)
        Object.assign(e.delivery, {
          verificationRunner: verificationContext.runner,
          verificationSignature: verificationContext.signature,
          beforeFingerprint: verificationContext.sourceFingerprint,
        });
    });
    let toolEvidence = false;
    const view = workspaceView(task, entry);
    const continuation =
      stage === 'publish'
        ? this.store
            .get(task.id)
            .deliveryRuns?.findLast(
              (run) =>
                run.stage === 'publish' &&
                run.repositoryId === entry.repository.id &&
                run.harness === harness &&
                run.id !== record.id &&
                run.sessionId &&
                run.approvalBaseline?.ref === context.approvalBaseline?.ref,
            )
        : null;
    const result = await (stage === 'publish' ? this.publish : this.validate)({
      task: {
        ...view,
        debugContext: undefined,
        memorySnapshot,
        verificationContext,
        repositoryMap: workspaces(task).map((e) => ({
          repository: e.repository,
          workspace: e.workspace,
          workspaceRoot: e.workspaceRoot,
          branch: e.branch,
          baseCommit: e.baseCommit,
        })),
        publicationContext: {
          branch: entry.branch,
          baseCommit: entry.baseCommit,
          originalHead: record.originalHead,
          acceptedContent: record.content,
          previous: record.previous,
          followUpRequest: record.followUpRequest,
          ...(record.followUpRequest
            ? {
                requestScope:
                  'Update the existing PR as requested. This request authorizes PR metadata updates only, not source edits. If code changes are needed, return blocked and direct the user to Request edits. Preserve the approved source and draft status.',
              }
            : {}),
          submission: entry.submission
            ? {
                ...entry.submission,
                stdout: entry.submission.stdout?.slice(-12000),
                stderr: entry.submission.stderr?.slice(-12000),
              }
            : null,
          providerHint: entry.repository.prCommand,
          expectedDraft: record.followUpRequest ? entry.publication?.draft !== false : true,
          approvalBaseline: record.approvalBaseline,
          ...context,
        },
      },
      stage,
      harness,
      sessionId: continuation?.sessionId,
      config: {
        ...config,
        timeoutMinutes: stage === 'publish' ? 15 : (config.timeoutMinutes ?? 30),
      },
      directory: this.store.directory,
      attemptId: record.id,
      signal,
      onEvent: (event) => {
        if (event.kind === 'tool') toolEvidence = true;
        this.store.event(task.id, {
          ...event,
          stage,
          harness,
          repositoryId: entry.repository.id,
          attemptId: record.id,
        });
        if (event.type === 'activity' && event.kind === 'message')
          this.update(task.id, entry.repository.id, (e) => {
            e.delivery.summary = event.summary.slice(0, 400);
          });
      },
      onModel: (model) =>
        this.update(task.id, entry.repository.id, (e) => {
          e.delivery.actualModel = model;
        }),
      onTerminal: (terminal) =>
        this.update(task.id, entry.repository.id, (e) => {
          e.delivery.terminal = terminal;
        }),
      onSession: (sessionId) =>
        this.update(task.id, entry.repository.id, (e) => {
          e.delivery.sessionId = sessionId;
        }),
    });
    requireValue(!signal.aborted, 'Publication stopped; work is preserved for retry');
    return { result, toolEvidence, record };
  }
  finishRun(id, repoId, result, extra = {}) {
    return this.update(
      id,
      repoId,
      (e) => {
        Object.assign(e.delivery, {
          status: result.verdict === 'complete' ? 'complete' : 'blocked',
          summary: result.summary,
          details: result.details,
          evidence: result.evidence ?? [],
          options: result.options ?? [],
          nextAction: result.risks?.join('\n') || result.details,
          finishedAt: new Date().toISOString(),
          ...extra,
        });
      },
      {
        type: 'publication',
        summary: result.summary,
        details: result.details,
        repositoryId: repoId,
      },
    );
  }
  async checkpoint(task, entry) {
    const previous = entry.delivery?.approvalBaseline;
    if (previous) return previous;
    const head = await git(entry.workspaceRoot, ['rev-parse', 'HEAD']);
    const ref = `refs/relay/publication/${task.id}/${entry.delivery.id}`;
    await git(entry.workspaceRoot, ['update-ref', ref, head]);
    const directory = join(this.store.directory, 'artifacts', task.id, entry.delivery.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'accepted-change.json');
    const untracked = [];
    for (const name of (
      await git(entry.workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z'], {
        raw: true,
      })
    )
      .split('\0')
      .filter(Boolean)) {
      const file = join(entry.workspaceRoot, name),
        stat = await lstat(file);
      requireValue(
        stat.isFile() && stat.size <= 16 * 1024 * 1024,
        'Cannot snapshot untracked publication file',
      );
      untracked.push({
        path: name,
        mode: stat.mode & 0o111,
        base64: (await readFile(file)).toString('base64'),
      });
    }
    await writeFile(
      path,
      JSON.stringify({
        baseCommit: entry.baseCommit,
        head,
        patch: await git(entry.workspaceRoot, ['diff', '--binary', entry.baseCommit, '--'], {
          raw: true,
        }),
        untracked,
      }),
      { mode: 0o600 },
    );
    return { ref, head, baseCommit: entry.baseCommit, acceptedSource: path };
  }
  async revalidate(task, entry, signal, preparation) {
    const entries = workspaces(task),
      before = await fingerprint(task);
    const record = workspaces(this.store.get(task.id)).find(
      (e) => e.repository.id === entry.repository.id,
    ).delivery;
    const runner = await prepareCheckRunner(
      this.store.directory,
      task.id,
      randomUUID(),
      entries,
      before,
      verificationSignature(entries),
      (executionConfig(task, this.store.config, 'implement').timeoutMinutes ?? 30) * 60000,
    );
    const priorEvidence = publicationEvidence(this.store.get(task.id), runner.signature);
    let correction = null,
      verifiedEvidence = null,
      toolEvidence = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const input = await this.invoke(
        task,
        entry,
        signal,
        {
          phase: 'verify',
          preparation,
          previousValidation: correction,
          checkScope: PUBLICATION_CHECK_SCOPE,
        },
        {
          stage: 'verify',
          verificationContext: {
            executionAccess: 'host',
            sourceFingerprint: before,
            signature: runner.signature,
            runner,
            repositories: entries.map((e) => e.repository.id),
            priorEvidence,
          },
        },
      );
      requireValue(
        before === (await fingerprint(task)),
        'Verification changed source; publication has stopped for inspection',
      );
      toolEvidence ||= input.toolEvidence;
      const journal = await readCheckJournal(runner);
      try {
        requireValue(
          input.result.verdict === 'complete',
          input.result.summary || 'Verification could not complete',
        );
        validateVerification(input.result, entries, toolEvidence, {
          journal,
          sourceFingerprint: before,
          signature: runner.signature,
          priorEvidence,
        });
        this.finishRun(task.id, entry.repository.id, input.result, {
          verificationRunner: runner,
          verificationEvidence: journal,
          verificationReport: input.result.verification,
          verificationSignature: runner.signature,
          beforeFingerprint: before,
        });
        verifiedEvidence = { report: input.result.verification, checks: journal };
        correction = null;
        break;
      } catch (error) {
        correction = { summary: error.message, report: input.result, checks: journal };
        this.finishRun(
          task.id,
          entry.repository.id,
          { ...input.result, verdict: 'changes_requested', summary: error.message },
          { verificationRunner: runner, verificationEvidence: journal },
        );
        if (
          error.code === 'VERIFICATION_CHECK_FAILED' ||
          input.result.verdict !== 'complete' ||
          attempt === 1
        )
          return { verdict: 'changes_requested', ...correction };
      }
    }
    const review = await this.invoke(
      task,
      entry,
      signal,
      {
        phase: 'review',
        preparation,
        checkScope: PUBLICATION_CHECK_SCOPE,
        verifiedFingerprint: before,
        verification: verifiedEvidence,
        approvedGoal: task.chosenApproach,
        approvalBaseline: record.approvalBaseline,
      },
      { stage: 'review' },
    );
    requireValue(
      before === (await fingerprint(task)),
      'Review changed source; publication has stopped for inspection',
    );
    this.finishRun(task.id, entry.repository.id, review.result);
    if (review.result.verdict !== 'complete' || review.result.findings?.length)
      return {
        ...review.result,
        verdict: review.result.verdict === 'blocked' ? 'blocked' : 'changes_requested',
      };
    requireValue(review.result.evidence?.length, 'Independent publication review needs evidence');
    return {
      verdict: 'complete',
      fingerprint: before,
      summary: review.result.summary,
      evidence: review.result.evidence,
    };
  }
  async run(task, entry, content, originalHead, signal) {
    const id = task.id,
      repoId = entry.repository.id;
    task = this.store.get(task.id);
    entry = workspaces(task).find((e) => e.repository.id === entry.repository.id);
    let view = workspaceView(task, entry),
      baseline,
      pending = null;
    try {
      await Promise.allSettled(
        [...this.monitor.running.entries()]
          .filter(([key]) => key.startsWith(`${id}:`))
          .map(([, r]) => r.done),
      );
      baseline = await this.checkpoint(task, entry);
      this.update(id, repoId, (e) => {
        e.delivery.approvalBaseline = baseline;
        e.delivery.auxiliary = true;
        e.delivery.stage = 'publish';
      });
      const otherBefore = new Map();
      for (const other of workspaces(task).filter((e) => e.repository.id !== repoId))
        otherBefore.set(other.repository.id, await fingerprint(workspaceView(task, other)));
      let phase = entry.delivery?.requiresReverification ? 'preparing' : 'publishing';
      let lastValidation;
      for (let round = 0; round < 4; round++) {
        const input = await this.invoke(
          task,
          entry,
          signal,
          {
            phase,
            repair: pending,
            approvalBaseline: baseline,
            policy:
              'Routine branch preparation, conflict resolution and repairs preserving the approved behavior are authorized. Any preparation must return verification_requested before pushing. Only genuine design choices or unavailable capabilities need human input.',
          },
          { first: round === 0 },
        );
        const result = input.result;
        for (const other of workspaces(task).filter((e) => e.repository.id !== repoId))
          requireValue(
            otherBefore.get(other.repository.id) ===
              (await fingerprint(workspaceView(task, other))),
            'Publication modified another repository',
          );
        if (result.verdict === 'blocked' || result.preparation?.scope === 'design_change') {
          const workingFingerprint = await fingerprint(view);
          const commit = await git(view.workspaceRoot, ['rev-parse', 'HEAD']);
          const historySafe = await git(view.workspaceRoot, [
            'merge-base',
            '--is-ancestor',
            originalHead,
            'HEAD',
          ]).then(
            () => true,
            () => false,
          );
          const sourceUnchanged =
            historySafe &&
            (await acceptedContent(view).then(
              (value) => value === content,
              () => false,
            ));
          this.finishRun(
            id,
            repoId,
            { ...result, verdict: 'blocked' },
            {
              phase: 'needs_attention',
              workingFingerprint,
              commit,
              requiresReverification: !sourceUnchanged,
            },
          );
          return;
        }
        requireValue(
          (await git(view.workspaceRoot, ['branch', '--show-current'])) === entry.branch,
          'Publication must return to its assigned branch',
        );
        if (result.verdict === 'verification_requested') {
          const prep = result.preparation;
          requireValue(
            prep && /^[0-9a-f]{40,64}$/.test(prep.baseCommit),
            'Prepared publication needs its exact new base commit',
          );
          await git(view.workspaceRoot, ['merge-base', '--is-ancestor', prep.baseCommit, 'HEAD']);
          await git(view.workspaceRoot, [
            'merge-base',
            '--is-ancestor',
            baseline.baseCommit,
            prep.baseCommit,
          ]);
          requireValue(
            prep.baseCommit !== (await git(view.workspaceRoot, ['rev-parse', 'HEAD'])),
            'Publication base cannot hide the entire accepted change',
          );
          requireValue(
            !(await git(view.workspaceRoot, ['status', '--porcelain', '--untracked-files=normal'])),
            'Commit prepared changes before verification',
          );
          if (prep.scope !== 'routine') {
            this.finishRun(
              id,
              repoId,
              { ...result, verdict: 'blocked', summary: prep.summary || result.summary },
              {
                phase: 'needs_attention',
                requiresReverification: true,
                workingFingerprint: await fingerprint(view),
              },
            );
            return;
          }
          entry.baseCommit = prep.baseCommit;
          view = workspaceView(task, entry);
          const workingFingerprint = await fingerprint(view);
          this.finishRun(
            id,
            repoId,
            { ...result, verdict: 'complete' },
            { phase: 'prepared', workingFingerprint, requiresReverification: true },
          );
          this.update(id, repoId, (e, t) => {
            e.baseCommit = prep.baseCommit;
            e.delivery.workingFingerprint = workingFingerprint;
            syncPrimary(t);
          });
          task = this.store.get(id);
          entry = workspaces(task).find((e) => e.repository.id === repoId);
          view = workspaceView(task, entry);
          const validation =
            lastValidation?.fingerprint === workingFingerprint &&
            lastValidation.baseCommit === prep.baseCommit
              ? lastValidation.result
              : await this.revalidate(task, entry, signal, prep);
          if (validation.verdict === 'complete')
            lastValidation = {
              fingerprint: workingFingerprint,
              baseCommit: prep.baseCommit,
              result: validation,
            };
          if (validation.verdict === 'blocked') {
            this.finishRun(id, repoId, validation, { phase: 'needs_attention' });
            return;
          }
          if (validation.verdict !== 'complete') {
            pending = validation;
            phase = 'preparing';
            continue;
          }
          content = await acceptedContent(view);
          originalHead = await git(view.workspaceRoot, ['rev-parse', 'HEAD']);
          this.update(id, repoId, (e, t) => {
            e.acceptedFingerprint = workingFingerprint;
            Object.assign(e.delivery, {
              requiresReverification: false,
              content,
              originalHead,
              workingFingerprint,
              validatedFingerprint: workingFingerprint,
            });
            t.approvals ??= [];
            t.approvals.push({
              type: 'publication_revalidation',
              at: new Date().toISOString(),
              repositoryId: repoId,
              fingerprint: workingFingerprint,
              summary:
                'Routine branch preparation verified and independently reviewed under the existing human approval.',
              evidence: validation.evidence,
            });
          });
          task = this.store.get(id);
          entry = workspaces(task).find((e) => e.repository.id === repoId);
          view = workspaceView(task, entry);
          phase = 'publishing';
          pending = null;
          continue;
        }
        requireValue(
          phase === 'publishing' && !entry.delivery?.requiresReverification,
          'Prepared branch must pass verification and independent review before publication',
        );
        requireValue(
          (await acceptedContent(view)) === content,
          'Source changed without publication verification; work is preserved',
        );
        await git(view.workspaceRoot, ['merge-base', '--is-ancestor', originalHead, 'HEAD']);
        const commit = await git(view.workspaceRoot, ['rev-parse', 'HEAD']);
        const publication = publicationSnapshot(result.publication);
        if (result.verdict === 'complete') {
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
        this.finishRun(id, repoId, result, {
          commit,
          phase: result.verdict === 'complete' ? 'monitoring' : 'needs_attention',
        });
        if (publication.url)
          this.update(id, repoId, (e) => {
            e.publication = {
              ...publication,
              summary: result.summary,
              evidence: result.evidence,
              checkedAt: new Date().toISOString(),
            };
          });
        if (result.verdict === 'complete') this.monitor.configure(id, repoId, true);
        return;
      }
      throw new Error(
        'Publication repair budget exhausted. All work and diagnostics are preserved; review the remaining obstacle before retrying.',
      );
    } catch (error) {
      const branch = await git(view.workspaceRoot, ['branch', '--show-current']).catch(() => null);
      const workingFingerprint = await fingerprint(view).catch(() => null);
      const historySafe = await git(view.workspaceRoot, [
        'merge-base',
        '--is-ancestor',
        originalHead,
        'HEAD',
      ]).then(
        () => true,
        () => false,
      );
      const unchanged =
        historySafe &&
        (await acceptedContent(view).then(
          (value) => value === content,
          () => false,
        ));
      const active = workspaces(this.store.get(id)).find(
        (e) => e.repository.id === repoId,
      ).delivery;
      const interruptedEvidence = active.verificationRunner
        ? await readCheckJournal(active.verificationRunner).catch(() => [])
        : active.verificationEvidence;
      this.update(
        id,
        repoId,
        (e) =>
          Object.assign(e.delivery, {
            status: signal.aborted ? 'interrupted' : 'blocked',
            verificationEvidence: interruptedEvidence,
            phase: 'needs_attention',
            summary: signal.aborted
              ? 'Publication paused; work is preserved.'
              : 'Publication needs attention.',
            details: error.message,
            nextAction: error.message,
            approvalBaseline: baseline ?? e.delivery.approvalBaseline,
            workingFingerprint,
            requiresReverification: !unchanged || !historySafe || branch !== entry.branch,
            commit: branch === entry.branch ? undefined : e.delivery.commit,
            finishedAt: new Date().toISOString(),
          }),
        {
          type: 'publication',
          summary: `Publication stopped: ${error.message}`,
          repositoryId: repoId,
        },
      );
      if (unchanged && historySafe && branch === entry.branch)
        this.update(id, repoId, (e) => {
          e.delivery.commit = originalHead;
        });
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
