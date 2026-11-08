import {
  prepareCheckRunner,
  readCheckJournal,
  priorVerificationEvidence,
  verificationSignature,
} from './verification-evidence.js';
import { memoryContext, proposeMemories } from './memory.js';
import { validateVerification } from './verification.js';
import { developmentAccess } from './access.js';
import {
  recoverBlocked,
  recoverInPlace,
  resumableAttempt,
  recoveryHarnesses,
  blockerDecision,
  continuationContext,
} from './recovery.js';
import { addComment, focusedFeedback } from './review-comments.js';
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
import { prepareWorkspace, fingerprint, inspectRepository, diff, git } from './workspace.js';
import { executeHarness, demoHandoff, resumeInvocation } from './harness.js';
import { runProcess, executableExists } from './process.js';

export class Engine {
  constructor(store, { harness = executeHarness, demoDelay = 650 } = {}) {
    this.store = store;
    this.harness = harness;
    this.demoDelay = demoDelay;
    this.running = new Map();
    this.manualRuns = new Map();
    this.controls = new Map();
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
      if (action === 'follow-up') {
        requireValue(
          status === 'completed',
          'Finish the current workflow before requesting follow-up edits',
          409,
        );
        requireValue(
          !this.running.has(id) && !this.manualRuns.has(id),
          'The workspace is busy',
          409,
        );
        const request = text(data.message, 'Follow-up request', 20000);
        const entries = workspaces(task);
        requireValue(
          !entries.some((entry) => ['merged', 'closed'].includes(entry.publication?.state)),
          'This PR has finished. Create a new task for further edits.',
          409,
        );
        const heads = [];
        for (const entry of entries) {
          requireValue(
            task.demo || (entry.workspace && entry.workspaceRoot && !entry.cleanedWorkspace),
            'The workspace was cleaned up. Create a new task to continue.',
            409,
          );
          requireValue(
            !this.workspaceReservations.has(entry.workspaceRoot),
            'Another process owns this workspace',
            409,
          );
          if (!task.demo) {
            const branch = await git(entry.workspaceRoot, ['symbolic-ref', '--short', 'HEAD']);
            requireValue(
              branch === entry.branch,
              'Workspace branch changed; inspect it before continuing',
              409,
            );
            heads.push(await git(entry.workspaceRoot, ['rev-parse', 'HEAD']));
          }
        }
        requireValue(
          entries.every((entry) => !this.workspaceReservations.has(entry.workspaceRoot)),
          'The workspace became busy',
          409,
        );
        const followUp = {
          id: randomUUID(),
          request,
          startedAt: new Date().toISOString(),
          previousApproach: task.chosenApproach,
        };
        for (const [index, entry] of entries.entries()) {
          if (!task.demo) {
            entry.workspaceHead = heads[index];
            this.workspaceReservations.set(entry.workspaceRoot, id);
          }
          entry.acceptedFingerprint = null;
          if (entry.publicationMonitor) entry.publicationMonitor.enabled = false;
        }
        syncPrimary(task);
        task.followUpContext = followUp;
        (task.followUps ??= []).push(followUp);
        task.messages.push({
          id: randomUUID(),
          at: followUp.startedAt,
          role: 'user',
          text: request,
        });
        task.chosenApproach = null;
        task.verifiedFingerprint = null;
        task.reviewedFingerprint = null;
        task.verificationCheckpoint = null;
        task.verificationReportRepair = null;
        task.recovery = null;
        task.blockerDecision = null;
        task.budgetContinuationAttemptId = null;
        task.round = 0;
        task.repositoryCursor = 0;
        task.stage = 'plan';
        task.status = 'queued';
        task.error = null;
        this.store.save(task, {
          type: 'follow_up',
          summary: 'Follow-up edits requested. Planning in the existing workspace.',
          details: request,
        });
      } else if (action === 'sync-base') {
        requireValue(
          !this.running.has(id) && !this.manualRuns.has(id),
          'Wait for the active process to stop',
          409,
        );
        requireValue(
          ['blocked', 'paused', 'interrupted'].includes(status),
          'Pause the task before synchronizing its base',
          409,
        );
        requireValue(
          !task.recoveryNotBefore || Date.now() >= task.recoveryNotBefore,
          'Wait for interrupted workers to stop',
          409,
        );
        const entry = workspaces(task).find(
          (e) => e.repository.id === (data.repositoryId ?? task.repository.id),
        );
        requireValue(entry?.workspaceRoot && !task.demo, 'Select an existing workspace');
        requireValue(
          typeof data.baseCommit === 'string' && /^[a-f0-9]{40,64}$/.test(data.baseCommit),
          'Supply a full base commit',
        );
        requireValue(
          data.expectedBaseCommit === entry.baseCommit,
          'Recorded base changed; reload before retrying',
          409,
        );
        const view = workspaceView(task, entry);
        const before = await fingerprint(view);
        requireValue(
          data.expectedFingerprint === before,
          'Workspace changed; inspect it before synchronizing',
          409,
        );
        const head = await git(entry.workspaceRoot, ['rev-parse', 'HEAD']);
        requireValue(
          head === data.baseCommit,
          'New base must match the inspected workspace HEAD',
          409,
        );
        requireValue(
          (await git(entry.workspaceRoot, ['symbolic-ref', '--short', 'HEAD'])) === entry.branch,
          'Workspace branch changed',
          409,
        );
        await git(entry.workspaceRoot, ['merge-base', '--is-ancestor', entry.baseCommit, head]);
        requireValue(
          (await fingerprint(view)) === before,
          'Workspace changed during synchronization',
          409,
        );
        const oldBase = entry.baseCommit;
        entry.baseCommit = head;
        entry.workspaceHead = head;
        syncPrimary(task);
        task.verifiedFingerprint = null;
        task.reviewedFingerprint = null;
        task.verificationReportRepair = null;
        task.recovery = null;
        task.blockerDecision = null;
        task.budgetContinuationAttemptId = null;
        task.status = 'paused';
        task.error = null;
        this.store.save(task, {
          type: 'workspace_base',
          repositoryId: entry.repository.id,
          summary:
            'Recorded base synchronized with the inspected workspace. Prior evidence is retained; verification must assess the updated base.',
          details: JSON.stringify({ oldBase, baseCommit: head, fingerprint: before }),
        });
      } else if (action === 'review-comment') {
        const comment = await addComment(task, data);
        this.store.save(task, {
          type: 'feedback',
          summary: `Inline comment on ${comment.anchor.path}:${comment.anchor.line}`,
          details: comment.text,
        });
      } else if (action === 'resolve-comment') {
        requireValue(task.status === 'awaiting_final', 'Resolve comments at final approval', 409);
        const comment = task.reviewComments?.find((c) => c.id === data.commentId);
        requireValue(comment, 'Review comment not found', 404);
        comment.status = 'resolved';
        this.store.save(task, {
          type: 'feedback',
          summary: `Resolved feedback on ${comment.anchor.path}:${comment.anchor.line}`,
        });
      } else if (action === 'takeover') {
        requireValue(
          !task.demo && !['draft', 'completed', 'cancelled'].includes(status),
          'Start a real workflow before taking over',
          409,
        );
        requireValue(
          !this.manualRuns.has(id) && !(status === 'manual' && task.manual?.active),
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
        const sessionAttemptId =
          data.sessionAttemptId ?? (status === 'manual' ? task.manual?.sessionAttemptId : null);
        const sessionAttempt = sessionAttemptId
          ? task.attempts.find(
              (a) =>
                a.id === sessionAttemptId &&
                a.sessionId &&
                (a.workspaceRepositoryId ?? a.repositoryId ?? workspaces(task)[0].repository.id) ===
                  entry.repository.id,
            )
          : null;
        requireValue(
          !sessionAttemptId || sessionAttempt,
          'No matching native session in this repository',
        );
        const invocation = sessionAttempt
          ? resumeInvocation(
              sessionAttempt.harness,
              executionConfig(task, this.store.config, sessionAttempt.stage).harnesses[
                sessionAttempt.harness
              ],
              sessionAttempt.sessionId,
              !!task.chosenApproach && sessionAttempt.stage === 'implement',
              developmentAccess(workspaceView(task, entry), sessionAttempt.stage),
            )
          : { command: process.env.SHELL || '/bin/sh', args: ['-i'] };
        task.status = 'manual';
        task.stage = task.chosenApproach ? 'verify' : 'investigate';
        task.repositoryCursor = 0;
        task.reviewedFingerprint = null;
        task.verifiedFingerprint = null;
        task.error = null;
        task.manual = {
          repositoryId: entry.repository.id,
          startedAt: new Date().toISOString(),
          sessionAttemptId: sessionAttempt?.id ?? null,
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
        run.done = runProcess(invocation.command, invocation.args, {
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
          .then((result) => {
            const current = this.store.get(id);
            current.manual.output = result.stdout.slice(-24000);
            current.manual.result = { code: result.code, signal: result.signal };
            this.store.save(current, {
              type: 'activity',
              summary:
                result.code === 0
                  ? 'Manual terminal exited.'
                  : `Manual terminal exited (${result.signal || result.code}).`,
              details: current.manual.output,
            });
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
      } else if (action === 'verify-blocker') {
        requireValue(
          status === 'blocked' && !this.running.has(id),
          'Wait for a blocked, idle task',
          409,
        );
        requireValue(
          task.stage === 'implement' && task.chosenApproach,
          'Trusted checks require an approved implementation',
          409,
        );
        requireValue(
          !task.recoveryNotBefore || Date.now() >= task.recoveryNotBefore,
          'Wait for interrupted workers to stop',
          409,
        );
        const entries = workspaces(task);
        requireValue(
          entries.every(
            (entry) =>
              entry.workspace &&
              (entry.repository.verificationMode !== 'commands' || entry.repository.checks.length),
          ),
          'Configure checks and prepare workspaces first',
          409,
        );
        const source = task.attempts.findLast(
          (a) =>
            a.role !== 'debug' &&
            a.role !== 'verifier' &&
            a.stage === task.stage &&
            (a.repositoryId ?? null) ===
              (entries.length > 1 ? entries[task.repositoryCursor ?? 0].repository.id : null),
        );
        task.recovery = {
          ...task.recovery,
          key: `${task.stage}:${task.repositoryCursor ?? 0}`,
          sourceAttemptId: source?.id,
          active: false,
          phase: 'trusted_verification',
        };
        task.status = 'queued';
        task.error = null;
        task.blockerDecision = null;
        this.store.save(task, {
          type: 'queued',
          summary: 'Running configured checks before continuing the interrupted implementation.',
        });
      } else if (action === 'debug' || action === 'resolve-blocker') {
        requireValue(
          status === 'blocked' && !this.running.has(id),
          'Wait for a blocked, idle task',
          409,
        );
        requireValue(
          !task.recoveryNotBefore || Date.now() >= task.recoveryNotBefore,
          'Wait for interrupted workers to stop',
          409,
        );
        if (action === 'resolve-blocker') {
          requireValue(
            task.blockerDecision &&
              !task.blockerDecision.resolved &&
              data.decisionId === task.blockerDecision.id,
            'This blocker decision has changed. Refresh before deciding.',
            409,
          );
          requireValue(
            ['retry', 'replan', 'pause'].includes(data.resolution),
            'Choose a blocker resolution',
          );
          const option = data.optionId
            ? task.blockerDecision.options.find((o) => o.id === data.optionId)
            : null;
          requireValue(!data.optionId || option, 'Choose a current debugging option');
          task.blockerDecision.resolved = true;
          task.blockerDecision.resolution = data.resolution;
          if (option)
            task.messages.push({
              id: randomUUID(),
              at: new Date().toISOString(),
              text: `Debugger direction selected: ${option.title}. ${option.description} Tradeoffs: ${option.tradeoffs}. Diagnose within existing permissions. Routine verification repairs supporting the approved goal may return to the original implementation agent; new behavior or a different approach needs revised approval.`,
              role: 'user',
              delivery: 'pending',
            });
        }
        if (data.resolution === 'pause') task.status = 'paused';
        else if (data.resolution === 'replan') {
          task.stage = 'plan';
          task.repositoryCursor = 0;
          task.chosenApproach = null;
          task.round = 0;
          task.verifiedFingerprint = null;
          task.reviewedFingerprint = null;
          task.recovery = null;
          task.error = null;
          task.status = 'queued';
        } else {
          const handoff = task.attempts.findLast((a) => a.handoff)?.handoff ?? {
            summary: task.error || 'Diagnose the blocked workflow',
            details: '',
            evidence: [],
            risks: [],
            options: [],
          };
          task.recovery = null;
          recoverBlocked(
            task,
            handoff,
            Math.max(
              1,
              task.execution?.maxRecoveryAttempts ?? this.store.config.maxRecoveryAttempts ?? 2,
            ),
            true,
          );
        }
        this.store.save(task, {
          type: 'decision',
          summary:
            data.resolution === 'replan'
              ? 'Requested a revised approach; new implementation approval required.'
              : data.resolution === 'pause'
                ? 'Paused after blocker review.'
                : 'Requested a dedicated diagnostic agent.',
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
        const budgetAttempt =
          task.blockerDecision?.kind === 'runtime_budget' ? task.attempts.at(-1) : null;
        task.budgetContinuationAttemptId = budgetAttempt?.id ?? null;
        if (budgetAttempt?.role !== 'debug') task.recovery = null;
        if (task.blockerDecision?.kind === 'verification_report' && task.verificationReportRepair)
          task.verificationReportRepair.count = 0;
        task.blockerDecision = null;
        if (!task.demo) {
          const roots = new Set();
          for (const entry of workspaces(task)) {
            requireValue(
              entry.repository.verificationMode !== 'commands' ||
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
        requireValue(
          !task.messages.some((m) => m.delivery === 'pending'),
          'Pending direction must be processed before approval. Request proposal changes first.',
          409,
        );
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
        let note = text(data.note, 'Feedback', 20000);
        if (data.commentIds?.length) {
          requireValue(
            status === 'awaiting_final',
            'Focused code repair requires final review',
            409,
          );
          note += '\n\nFocused inline feedback:\n' + (await focusedFeedback(task, data.commentIds));
        }
        task.messages.push({ at: new Date().toISOString(), text: note, role: 'user' });
        task.stage = status === 'awaiting_plan' ? 'plan' : 'implement';
        task.repositoryCursor = 0;
        task.status = 'queued';
        task.reviewedFingerprint = null;
        this.store.save(task, { type: 'feedback', summary: 'Changes requested.', details: note });
      } else if (action === 'accept') {
        requireValue(
          !task.reviewComments?.some((c) => c.status === 'open'),
          'Resolve inline comments or request focused repairs before acceptance',
          409,
        );
        requireValue(
          !task.messages.some((m) => m.delivery === 'pending'),
          'Pending direction must be processed before acceptance. Request changes first.',
          409,
        );
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
      } else if (action === 'message' || action === 'steer') {
        requireValue(
          !['completed', 'cancelled'].includes(status),
          'Finished tasks cannot receive direction',
          409,
        );
        const message = {
          id: randomUUID(),
          at: new Date().toISOString(),
          text: text(data.message, 'Message', 20000),
          role: 'user',
          delivery: 'pending',
        };
        if (action === 'steer')
          requireValue(
            status === 'running' &&
              (this.controls.has(id) ||
                task.attempts.findLast((a) => a.status === 'running')?.harness === 'claude'),
            'Live steering is not ready for this stage',
            409,
          );
        task.messages.push(message);
        this.store.save(task, {
          type: 'feedback',
          summary:
            action === 'steer'
              ? 'Sending direction to the active session.'
              : 'Context pending for the next agent.',
          details: message.text,
        });
        if (action === 'steer') {
          if (this.controls.has(id)) {
            try {
              const activeAttemptId = task.attempts.findLast((a) => a.status === 'running')?.id;
              await this.controls.get(id)(message.id, message.text);
              const current = this.store.get(id);
              Object.assign(
                current.messages.find((m) => m.id === message.id),
                {
                  delivery: 'accepted',
                  attemptId: activeAttemptId,
                },
              );
              this.store.save(current, {
                type: 'feedback',
                summary:
                  'Active harness accepted direction. Completion still requires a valid handoff.',
                details: message.text,
              });
            } catch (error) {
              this.store.event(id, {
                type: 'feedback',
                summary: error.message,
                details: message.text,
              });
              throw error;
            }
          } else {
            const active = task.attempts.findLast((a) => a.status === 'running');
            requireValue(active?.sessionId, 'Wait for Claude to report its native session', 409);
            task.status = 'paused';
            this.store.save(task);
            this.running.get(id)?.abort();
            while (this.running.has(id)) await delay(25);
            const current = this.store.get(id);
            current.status = 'queued';
            this.store.save(current, {
              type: 'feedback',
              summary: 'Claude interrupted; resuming its native conversation with your direction.',
            });
          }
        }
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
        .catch(async (error) => {
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
            const diagnosticFailure = {
              summary: error.message,
              details:
                'The process failed before a valid handoff. Diagnose the recorded command results and tool access before retrying the interrupted stage.',
              evidence: [],
              risks: [error.message],
              options: [],
            };
            const changedDuringAnalysis =
              attempt?.beforeFingerprint &&
              (attempt.role === 'debug' || attempt.stage !== 'implement') &&
              (await fingerprint(current)
                .then((value) => value !== attempt.beforeFingerprint)
                .catch(() => true));
            const latest = this.store.get(task.id);
            if (['paused', 'cancelled', 'manual'].includes(latest?.status)) {
              const interrupted = latest.attempts.find((a) => a.id === attempt?.id);
              if (interrupted?.status === 'running') {
                interrupted.status = 'interrupted';
                interrupted.finishedAt = new Date().toISOString();
                this.store.save(latest);
              }
              return;
            }
            current.messages = latest.messages;
            if (attempt?.verificationRunner)
              attempt.verificationEvidence = await readCheckJournal(
                attempt.verificationRunner,
              ).catch(() => []);
            if (attempt) attempt.errorCode = error.code ?? null;
            if (!changedDuringAnalysis && error.code === 'RUNTIME_BUDGET_EXHAUSTED') {
              if (attempt) attempt.runtimeBudget = error.budget;
              if (attempt?.role !== 'debug') current.recovery = null;
              current.blockerDecision = {
                ...blockerDecision(current, {
                  summary: 'Execution reached its time budget; completed evidence is preserved.',
                  details: error.message,
                  evidence: (attempt?.verificationEvidence ?? [])
                    .filter((c) => c.code === 0)
                    .map((c) => c.summary),
                  risks: [
                    'Continue the same stage with more time, or inspect its last progress. A timeout is not a failed test.',
                  ],
                }),
                kind: 'runtime_budget',
              };
              this.store.save(current, {
                type: 'blocked',
                summary:
                  'Time budget reached. No debugger was started; completed checks are preserved.',
              });
              return;
            }
            if (error.code === 'RELAY_PREPARATION_FAILED') {
              current.recovery = null;
              current.blockerDecision = {
                ...blockerDecision(current, {
                  ...diagnosticFailure,
                  details:
                    'Relay failed before the agent started. Source changes and completed evidence are preserved. Repair task metadata or local Git access, then retry verification.',
                }),
                kind: 'relay_preparation',
                ...(error.baseUpdate ? { baseUpdate: error.baseUpdate } : {}),
              };
              this.store.save(current, {
                type: 'blocked',
                summary: error.message,
                details:
                  'No debugger was started: this is a Relay preparation failure, not an agent or test failure.',
              });
              return;
            }
            if (
              !changedDuringAnalysis &&
              ['VERIFICATION_REPORT_INVALID', 'VERIFICATION_CHECK_FAILED'].includes(error.code) &&
              error.toolEvidence &&
              error.report?.checks?.length
            ) {
              const count = (current.verificationReportRepair?.count ?? 0) + 1;
              attempt.rejectedVerification = error.report;
              current.verificationReportRepair = {
                count,
                mode: error.code === 'VERIFICATION_CHECK_FAILED' ? 'check_recovery' : 'report_only',
                attemptId: attempt.id,
                fingerprint: attempt.beforeFingerprint,
                signature: attempt.verificationSignature,
                report: error.report,
                error: error.message,
                toolEvidence: true,
              };
              if (error.code === 'VERIFICATION_REPORT_INVALID') current.recovery = null;
              if (count > 2 && error.code === 'VERIFICATION_CHECK_FAILED') {
                current.verificationReportRepair = null;
                recoverBlocked(
                  current,
                  diagnosticFailure,
                  current.execution?.maxRecoveryAttempts ??
                    this.store.config.maxRecoveryAttempts ??
                    2,
                );
                this.store.save(current, {
                  type: current.status === 'queued' ? 'recovery' : 'blocked',
                  summary:
                    current.status === 'queued'
                      ? 'The verifier could not resolve its failed check; debugger queued with its recovery evidence.'
                      : 'Verifier recovery exhausted; failed checks remain blocking.',
                });
                return;
              }
              if (count <= 2) {
                current.status = 'queued';
                current.error = null;
                current.blockerDecision = null;
              } else
                current.blockerDecision = {
                  ...blockerDecision(current, {
                    summary:
                      error.code === 'VERIFICATION_CHECK_FAILED'
                        ? 'The verifier could not resolve a failed check.'
                        : 'Verification report still needs correction.',
                    details: error.message,
                    risks: [
                      error.code === 'VERIFICATION_CHECK_FAILED'
                        ? 'Inspect the failed command and attempted recovery. Passing checks remain preserved; unresolved failures still block review.'
                        : 'Executed checks are preserved. Inspect the report or resume its correction; no full test rerun is required solely for report formatting.',
                    ],
                  }),
                  kind: 'verification_report',
                };
              this.store.save(current, {
                type: current.status === 'queued' ? 'recovery' : 'blocked',
                summary:
                  count <= 2
                    ? error.code === 'VERIFICATION_CHECK_FAILED'
                      ? 'Verifier is resolving its failed check in the same conversation; completed checks are preserved.'
                      : 'Verifier is correcting its evidence report; completed checks are preserved.'
                    : error.code === 'VERIFICATION_CHECK_FAILED'
                      ? 'Verifier recovery limit reached; failed checks remain blocking.'
                      : 'Report correction limit reached; no debugger was started.',
              });
              return;
            }
            if (
              current.workspace &&
              !changedDuringAnalysis &&
              !/modified.*workspace|another repository|Workspace changed|reservation/i.test(
                error.message,
              )
            ) {
              if (recoverInPlace(current, error.message)) {
                this.store.save(current, {
                  type: 'recovery',
                  summary:
                    'Returning the interruption to the current agent before escalating to a debugger.',
                  details: error.message,
                });
                return;
              }
              recoverBlocked(
                current,
                diagnosticFailure,
                current.execution?.maxRecoveryAttempts ??
                  this.store.config.maxRecoveryAttempts ??
                  2,
              );
            } else current.blockerDecision = blockerDecision(current, diagnosticFailure);
            this.store.save(current, {
              type: current.status === 'queued' ? 'recovery' : 'blocked',
              summary:
                current.status === 'queued'
                  ? `Debugger queued after process failure: ${error.message}`
                  : error.message,
            });
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
        if (!entry.setupCompleted && !(task.recovery?.active && task.recovery.phase === 'debug')) {
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
    const trustedVerification = task.recovery?.phase === 'trusted_verification';
    const debugging = task.recovery?.active && task.recovery.phase === 'debug';
    const entries = workspaces(task);
    const agentVerification =
      !task.demo &&
      (stage === 'verify' || trustedVerification) &&
      entries.some((e) => e.repository.verificationMode !== 'commands');
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
    view.activeRepositoryId = entry.repository.id;
    let harness = debugging
      ? this.store.config.harnesses.codex?.enabled
        ? 'codex'
        : task.routing[stage === 'verify' ? 'implement' : stage]
      : agentVerification
        ? task.routing.implement
        : stage === 'verify' || trustedVerification
          ? 'checks'
          : task.routing[stage];
    if (debugging) {
      for (const candidate of [
        ...new Set([
          ...recoveryHarnesses(task, harness, this.store.config.harnesses),
          ...Object.keys(this.store.config.harnesses).filter(
            (id) => this.store.config.harnesses[id].enabled,
          ),
        ]),
      ]) {
        if (await executableExists(this.store.config.harnesses[candidate].command)) {
          harness = candidate;
          break;
        }
      }
    }
    const parentAttempt = task.attempts.at(-1);
    const firstFollowUp =
      task.followUpContext &&
      !task.attempts.some((run) => run.followUpId === task.followUpContext.id);
    const attempt = {
      followUpId: task.followUpContext?.id,
      parentAttemptId: parentAttempt?.id ?? null,
      relation: firstFollowUp
        ? 'Follow-up request'
        : task.verificationReportRepair && agentVerification && !debugging
          ? task.verificationReportRepair.mode === 'check_recovery'
            ? 'Resolve failed check'
            : 'Report correction'
          : trustedVerification
            ? 'Trusted verification'
            : debugging
              ? 'Diagnosis'
              : task.recovery?.phase === 'continue'
                ? 'Continue after diagnosis'
                : parentAttempt && task.round > parentAttempt.round
                  ? 'Repair / backtrack'
                  : parentAttempt?.stage === stage
                    ? 'Retry / next repository'
                    : 'Handoff',
      id: randomUUID(),
      stage,
      role: debugging
        ? 'debug'
        : trustedVerification || agentVerification
          ? 'verifier'
          : 'specialist',
      harness,
      round: task.round,
      repositoryId: scoped ? entry.repository.id : null,
      workspaceRepositoryId: entry.repository.id,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    view.memorySnapshot = memoryContext(
      this.store,
      task,
      scoped && !debugging ? [entry.repository.id] : entries.map((e) => e.repository.id),
    );
    attempt.memorySnapshot = view.memorySnapshot;
    if (debugging) {
      const recent = this.store.db
        .prepare(
          "SELECT body FROM events WHERE task_id=? AND json_extract(body,'$.type')='activity' AND json_extract(body,'$.kind')='tool' ORDER BY seq DESC LIMIT 12",
        )
        .all(id)
        .reverse()
        .map((row) => JSON.parse(row.body));
      view.debugContext = {
        executionAccess: 'host',
        interruptedAttempt: task.attempts.findLast(
          (a) =>
            a.role !== 'debug' &&
            a.stage === stage &&
            (a.repositoryId ?? null) === (attempt.repositoryId ?? null),
        ),
        blockedStage: stage,
        reason: task.recovery.reason,
        priorDiagnoses: task.recovery.evidence,
        recentCommandResults: recent.map((e) => ({
          summary: e.summary,
          details: e.details?.slice(-6000),
          repositoryId: e.repositoryId,
        })),
      };
    }
    if (agentVerification && !debugging) {
      view.verificationContext = {
        executionAccess: 'host',
        sourceFingerprint: null,
        repositories: entries.map((e) => e.repository.id),
      };
      // Agent verification discovers commands from source, not old private wrappers.
      view.repository = {
        ...view.repository,
        checks: view.repository.verificationMode === 'commands' ? view.repository.checks : [],
      };
      view.repositoryMap = view.repositoryMap.map((e) => ({
        ...e,
        repository: {
          ...e.repository,
          checks: e.repository.verificationMode === 'commands' ? e.repository.checks : [],
        },
      }));
      attempt.executionAccess = 'host';
    }
    if (debugging) {
      view.debugContext.capabilities = developmentAccess(view, 'investigate');
      attempt.executionAccess = 'host';
    }
    if (!debugging)
      view.continuationContext = continuationContext(task, stage, attempt.repositoryId);
    let previousSession = resumableAttempt(task, stage, harness, attempt.repositoryId);
    if (agentVerification && !debugging && task.verificationReportRepair)
      previousSession =
        task.attempts.find(
          (a) => a.id === task.verificationReportRepair.attemptId && a.harness === harness,
        ) ?? previousSession;
    if (task.budgetContinuationAttemptId)
      previousSession =
        task.attempts.find(
          (a) => a.id === task.budgetContinuationAttemptId && a.harness === harness,
        ) ?? previousSession;
    if (task.recovery?.active)
      attempt.recovery = { strategy: task.recovery.strategy, freshSession: true };
    attempt.model =
      executionConfig(task, this.store.config, agentVerification ? 'implement' : stage).harnesses[
        harness
      ]?.model || '';
    for (const message of task.messages)
      if (stage !== 'verify' && !trustedVerification && message.delivery === 'pending')
        message.attemptId = attempt.id;
    task.attempts.push(attempt);
    this.store.save(task, {
      type: 'stage_started',
      stage,
      harness,
      summary:
        agentVerification && !debugging
          ? `${harness} verification agent is discovering and running repository checks on the host.`
          : trustedVerification
            ? 'Running configured checks; implementation progress is preserved.'
            : debugging
              ? `${harness} elevated debugger is diagnosing the ${stage} blocker on the host.`
              : view.continuationContext
                ? `Continuing ${stage} from saved progress after diagnosis.`
                : stage === 'verify'
                  ? 'Running repository verification commands.'
                  : `${harness} is working on ${stage}${scoped ? ` · ${entry.repository.name}` : ''}.${task.recovery?.active ? ' Fresh diagnostic session with prior evidence.' : ''}`,
    });
    const before = !task.demo ? await fingerprint(task) : 'demo';
    const startedTask = this.store.get(id);
    startedTask.attempts.find((a) => a.id === attempt.id).beforeFingerprint = before;
    this.store.save(startedTask);
    if (stage === 'review' && !debugging)
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
    if (view.verificationContext) view.verificationContext.sourceFingerprint = before;
    if ((agentVerification && !debugging) || (debugging && stage === 'verify')) {
      const signature = verificationSignature(entries);
      const runner = await prepareCheckRunner(
        this.store.directory,
        id,
        attempt.id,
        entries,
        before,
        signature,
        executionConfig(task, this.store.config, stage).timeoutMinutes * 60000,
      );
      let sourceSnapshot;
      try {
        for (const workspace of entries) {
          const head = await git(workspace.workspaceRoot, ['rev-parse', 'HEAD']);
          if (head !== (workspace.workspaceHead ?? workspace.baseCommit)) {
            const error = new Error(
              `Recorded base for ${workspace.repository.name} differs from workspace HEAD. Synchronize the inspected base before verification; source changes and completed checks are preserved.`,
            );
            error.baseUpdate = {
              repositoryId: workspace.repository.id,
              baseCommit: head,
              expectedBaseCommit: workspace.baseCommit,
              expectedFingerprint: await fingerprint(workspaceView(task, workspace)),
            };
            throw error;
          }
        }
        sourceSnapshot = await diff(task);
      } catch (cause) {
        const error = new Error(`Relay could not prepare the verification diff: ${cause.message}`, {
          cause,
        });
        error.code = 'RELAY_PREPARATION_FAILED';
        error.baseUpdate = cause.baseUpdate;
        throw error;
      }
      const snapshotText = JSON.stringify(sourceSnapshot);
      const source =
        snapshotText.length < 60000
          ? sourceSnapshot
          : { omitted: true, reason: 'Diff exceeds evidence context limit; inspect local source.' };
      const current = this.store.get(id);
      const active = current.attempts.find((a) => a.id === attempt.id);
      active.verificationRunner = runner;
      active.verificationSignature = signature;
      active.verificationSourceSnapshot = source;
      this.store.save(current);
      const context = {
        sourceFingerprint: before,
        signature,
        runner,
        sourceSnapshot: source,
        priorEvidence: priorVerificationEvidence(task, signature),
      };
      if (view.verificationContext) Object.assign(view.verificationContext, context);
      if (view.debugContext) Object.assign(view.debugContext, { verification: context });
      if (
        task.verificationReportRepair?.fingerprint === before &&
        task.verificationReportRepair.signature === signature &&
        view.verificationContext
      )
        view.verificationContext.reportRepair = task.verificationReportRepair;
    }
    let verificationToolEvidence = view.verificationContext?.reportRepair?.toolEvidence === true;
    let handoff;
    if ((stage === 'verify' || trustedVerification) && !debugging && !agentVerification) {
      const checks = [];
      const signature = JSON.stringify(
        entries.map((e) => ({
          id: e.repository.id,
          workspace: e.workspace,
          baseCommit: e.baseCommit,
          checks: e.repository.checks,
        })),
      );
      const checkpoint = task.verificationCheckpoint;
      const reuse = checkpoint?.fingerprint === before && checkpoint.signature === signature;
      task.verificationCheckpoint = reuse
        ? checkpoint
        : { fingerprint: before, signature, results: {} };
      const checkpointTask = this.store.get(id);
      checkpointTask.verificationCheckpoint = task.verificationCheckpoint;
      this.store.save(checkpointTask);
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
          for (const [checkIndex, command] of checkEntry.repository.checks.entries()) {
            const checkKey = JSON.stringify([checkEntry.repository.id, checkIndex]);
            const priorResult = task.verificationCheckpoint.results[checkKey];
            if (reuse && priorResult?.code === 0) {
              checks.push({ ...priorResult, reusedFromAttemptId: priorResult.attemptId });
              this.store.event(id, {
                type: 'activity',
                kind: 'tool',
                stage,
                harness: 'checks',
                repositoryId: checkEntry.repository.id,
                attemptId: attempt.id,
                summary: `Preserved passing check: ${command.command} ${command.args.join(' ')}`,
              });
              continue;
            }
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
            let lastCommandProgress = null,
              lastCommandLine = null;
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
              progressPolicy: {
                maxTimeout: executionConfig(task, this.store.config, stage).timeoutMinutes * 120000,
                lastProgressAt: () => lastCommandProgress,
              },
              onBudget: (budget) => {
                const current = this.store.get(id);
                current.attempts.find((a) => a.id === attempt.id).runtimeBudget = budget;
                this.store.save(current);
                if (budget.extensions)
                  this.store.event(id, {
                    type: 'runtime_budget',
                    stage,
                    attemptId: attempt.id,
                    summary:
                      'Check output is progressing; time budget extended within the absolute cap.',
                  });
              },
              onLine: (line, stream) => {
                if (line.trim() && line !== lastCommandLine) {
                  lastCommandLine = line;
                  lastCommandProgress = Date.now();
                }
                return this.store.event(id, {
                  type: 'transcript',
                  stage,
                  attemptId: attempt.id,
                  repositoryId: checkEntry.repository.id,
                  stream,
                  text: line.slice(0, 40000),
                });
              },
            });
            this.store.event(id, {
              ...checkEvent,
              summary: `Check ${result.code === 0 ? 'passed' : 'failed'}: ${command.command} ${command.args.join(' ')}`,
              details: `${result.stdout}\n${result.stderr}`.slice(-40000),
            });
            const checkResult = {
              attemptId: attempt.id,
              repositoryId: checkEntry.repository.id,
              ...command,
              ...result,
              durationMs: Date.now() - started,
            };
            checks.push(checkResult);
            task.verificationCheckpoint.results[checkKey] = checkResult;
            const current = this.store.get(id);
            current.verificationCheckpoint = task.verificationCheckpoint;
            this.store.save(current);
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
    } else if (stage === 'triage' && !task.smartRouting && !debugging) {
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
      handoff = demoHandoff(task, debugging ? 'investigate' : stage);
    } else {
      requireValue(this.store.config.harnesses[harness]?.enabled, `${harness} is disabled`);
      handoff = await this.harness({
        task: view,
        stage: debugging ? 'investigate' : agentVerification ? 'verify' : stage,
        harness,
        config: executionConfig(task, this.store.config, agentVerification ? 'implement' : stage),
        directory: this.store.directory,
        attemptId: attempt.id,
        signal,
        sessionId: previousSession?.sessionId,
        onModel: (model) => {
          const current = this.store.get(id);
          const active = current.attempts.find((a) => a.id === attempt.id);
          active.actualModel = model;
          this.store.save(current);
        },
        onSession: (sessionId) => {
          const current = this.store.get(id);
          current.attempts.find((a) => a.id === attempt.id).sessionId = sessionId;
          this.store.save(current);
        },
        onControl: (control) => {
          if (control) this.controls.set(id, control);
          else this.controls.delete(id);
        },
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
        onEvent: (event) => {
          if (event.kind === 'tool') verificationToolEvidence = true;
          if (event.type === 'runtime_budget' || event.type === 'check_evidence') {
            const current = this.store.get(id);
            const active = current.attempts.find((a) => a.id === attempt.id);
            if (event.type === 'runtime_budget') active.runtimeBudget = event.budget;
            else active.verificationEvidence = event.checks;
            this.store.save(current);
          }
          return this.store.event(id, {
            ...event,
            stage,
            harness,
            repositoryId: entry.repository.id,
            attemptId: attempt.id,
          });
        },
      });
    }
    if (signal.aborted) throw new Error('Execution cancelled');
    const after = !task.demo ? await fingerprint(task) : 'demo';
    if (
      (debugging || ['triage', 'investigate', 'plan', 'review'].includes(stage)) &&
      before !== after
    )
      throw new Error(
        `${stage} modified the workspace despite being read-only. Inspect the diff before resuming.`,
      );
    if ((stage === 'verify' || trustedVerification) && !debugging && before !== after)
      throw new Error('Verification modified the workspace. Inspect the diff before resuming.');
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
    if (agentVerification && !debugging && handoff.verdict === 'complete') {
      const report = validateVerification(handoff, entries, verificationToolEvidence, {
        ...view.verificationContext,
        journal: await readCheckJournal(view.verificationContext.runner),
      });
      handoff.checks = report.checks.map((check) => ({
        ...check,
        stdout: check.summary,
        stderr: '',
      }));
    }
    if (['repair_requested', 'verification_requested'].includes(handoff.verdict)) {
      requireValue(
        stage === 'implement' &&
          task.chosenApproach &&
          (debugging || handoff.verdict === 'verification_requested'),
        'Verification requires an approved implementation; repair delegation requires a debugger',
      );
      if (handoff.verdict === 'verification_requested')
        requireValue(
          entries.every(
            (e) => e.repository.verificationMode !== 'commands' || e.repository.checks.length > 0,
          ),
          'Configure repository checks before requesting verification',
        );
    }
    if (handoff.verdict === 'verification_requested') {
      const repeated =
        task.hostVerificationRequests?.fingerprint === after
          ? task.hostVerificationRequests.count
          : 0;
      requireValue(
        repeated < 3,
        'Host results have already been returned for this source state. Resolve the remaining blocker or complete the handoff instead of requesting identical checks again.',
      );
      const current = this.store.get(id);
      current.hostVerificationRequests = { fingerprint: after, count: repeated + 1 };
      this.store.save(current);
    }
    task = this.store.get(id);
    const savedAttempt = task.attempts.find((a) => a.id === attempt.id);
    savedAttempt.handoff = handoff;
    task.budgetContinuationAttemptId = null;
    if (savedAttempt.verificationRunner)
      savedAttempt.verificationEvidence = await readCheckJournal(savedAttempt.verificationRunner);
    if (agentVerification && !debugging && handoff.verdict === 'complete')
      task.verificationReportRepair = null;
    savedAttempt.memoryProposalIds = proposeMemories(
      this.store,
      task,
      savedAttempt,
      handoff.memorySuggestions,
    ).map((m) => m.id);
    for (const message of task.messages)
      if (message.attemptId === attempt.id) message.delivery = 'included';
    savedAttempt.finishedAt = new Date().toISOString();
    savedAttempt.status = 'complete';
    savedAttempt.fingerprint = after;
    if (!debugging && view.continuationContext && handoff.verdict === 'complete')
      task.recovery.phase = 'continued';
    if (trustedVerification) {
      task.recovery.active = false;
      task.recovery.phase = 'continue';
      task.recovery.lastDiagnosis = {
        summary: handoff.summary,
        evidence: handoff.evidence,
        details: handoff.details,
        checks: (handoff.checks ?? []).map((check) => ({
          ...check,
          stdout: check.stdout.slice(-12000),
          stderr: check.stderr.slice(-6000),
        })),
        fingerprint: after,
      };
      task.status = 'queued';
      task.error = null;
      task.blockerDecision = null;
    } else if (
      handoff.verdict === 'verification_requested' ||
      (debugging && handoff.verdict === 'repair_requested')
    ) {
      task.recovery = {
        ...task.recovery,
        key: `${stage}:${task.repositoryCursor ?? 0}`,
        sourceAttemptId: debugging ? task.recovery?.sourceAttemptId : attempt.id,
        active: false,
        attempts: task.recovery?.attempts ?? 0,
        phase: handoff.verdict === 'verification_requested' ? 'trusted_verification' : 'continue',
      };
      task.recovery.lastDiagnosis = {
        summary: handoff.summary,
        details: handoff.details,
        evidence: handoff.evidence,
        risks: handoff.risks,
        disposition: handoff.verdict,
      };
      task.status = 'queued';
      task.error = null;
      task.blockerDecision = null;
    } else if (debugging && handoff.verdict === 'complete') {
      task.recovery.active = false;
      task.recovery.phase = 'continue';
      task.recovery.lastDiagnosis = {
        summary: handoff.summary,
        details: handoff.details,
        evidence: handoff.evidence,
        risks: handoff.risks,
        executionAccess: attempt.executionAccess,
      };
      task.status = 'queued';
      task.error = null;
      task.blockerDecision = null;
    } else if (debugging || handoff.verdict === 'blocked') {
      recoverBlocked(
        task,
        handoff,
        task.execution?.maxRecoveryAttempts ?? this.store.config.maxRecoveryAttempts ?? 2,
      );
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
      } else if (handoff.checks?.some((c) => c.code === 127)) {
        recoverBlocked(
          task,
          handoff,
          task.execution?.maxRecoveryAttempts ?? this.store.config.maxRecoveryAttempts ?? 2,
        );
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
      summary: debugging
        ? `${handoff.verdict === 'repair_requested' ? 'Debugger → targeted repair' : handoff.verdict === 'verification_requested' ? 'Debugger → verification' : 'Debugger'}: ${handoff.summary}`
        : scoped
          ? `${entry.repository.name}: ${handoff.summary}`
          : handoff.summary,
      details: handoff.details,
      attemptId: attempt.id,
    });
    if (handoff.verdict === 'blocked' || task.recovery?.active)
      this.store.event(id, {
        type: 'recovery',
        stage,
        harness,
        summary: task.recovery.active
          ? `Starting a fresh diagnosis (${task.recovery.attempts}/${task.execution?.maxRecoveryAttempts ?? this.store.config.maxRecoveryAttempts ?? 2}).`
          : 'Automatic recovery stopped. Your help is needed.',
        details: handoff.summary,
      });
    else if (task.recovery) {
      task.recovery.active = false;
      this.store.save(task);
    }
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
