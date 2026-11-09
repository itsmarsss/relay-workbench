import { completedPlan } from '../public/workflow-plan.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './domain.js';
import { workspaces } from './task-repositories.js';
import { readWorkflowHealth } from './workflow-health.js';

export function automationState(store, id) {
  const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(`automation:${id}`);
  return row ? JSON.parse(row.value) : { enabled: false, scope: 'reviewed' };
}
export function requireAutomationAuthorization(store, id, authorization, scope) {
  if (!authorization) return;
  const current = automationState(store, id);
  requireValue(
    current.enabled &&
      !current.error &&
      current.authorizationId === authorization.authorizationId &&
      (!scope || current.scope === scope),
    'Auto delegation changed; the automatic action was stopped',
    409,
  );
}
function taskContext(task) {
  return JSON.stringify([
    task.status,
    task.stage,
    task.attempts.length,
    task.attempts.at(-1)?.id,
    task.followUpContext?.id,
    workspaces(task).map((e) => [e.delivery?.id, e.delivery?.status]),
  ]);
}
function save(store, id, state) {
  store.db
    .prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)')
    .run(`automation:${id}`, JSON.stringify(state));
}
export class WorkflowAutomation {
  constructor(
    store,
    engine,
    publication,
    { isBusy = () => false, suspended = () => false, interval = 2000 } = {},
  ) {
    Object.assign(this, { store, engine, publication, isBusy, suspended });
    this.busy = false;
    this.stopped = false;
    this.timer = setInterval(
      () =>
        this.tick().catch((error) => {
          this.lastError = error.message;
        }),
      interval,
    );
    this.timer.unref();
  }
  configure(id, request) {
    requireValue(
      request && typeof request === 'object' && !Array.isArray(request),
      'Invalid Auto configuration',
    );
    const { enabled, scope = 'reviewed' } = request;
    requireValue(typeof enabled === 'boolean', 'Choose whether Auto mode is enabled');
    requireValue(['reviewed', 'draft_pr'].includes(scope), 'Choose a supported Auto scope');
    const previous = automationState(this.store, id);
    // Toggling does not reset retry allowances or publication receipts.
    const state = {
      ...previous,
      enabled,
      scope,
      authorizationId: randomUUID(),
      authorizedAt: new Date().toISOString(),
      error: null,
      errorContext: null,
    };
    save(this.store, id, state);
    this.store.event(id, {
      type: 'automation',
      summary: enabled
        ? `Auto enabled: ${scope === 'draft_pr' ? 'finish through draft PR' : 'finish through reviewed result'}.`
        : 'Auto disabled.',
      details:
        'User delegation. Verification, independent review and recovery limits remain required.',
    });
    return state;
  }
  receipt(id, state, summary, parentAttemptId) {
    this.store.event(id, {
      type: 'auto_decision',
      id: randomUUID(),
      parentAttemptId,
      summary,
      authorizationId: state.authorizationId,
      scope: state.scope,
    });
  }
  async tick() {
    if (this.busy || this.stopped || this.suspended()) return;
    this.busy = true;
    try {
      for (const listed of this.store.all()) {
        const task = this.store.get(listed.id);
        if (!task) continue;
        if (this.stopped || this.suspended()) break;
        const health = readWorkflowHealth(this.store, task);
        if (health.quiet) {
          const key = `quiet:${task.id}:${health.attemptId}`;
          if (!this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(key)) {
            this.store.db
              .prepare('INSERT INTO meta(key,value) VALUES (?,?)')
              .run(key, health.lastAt);
            this.store.event(task.id, {
              type: 'quiet',
              attemptId: health.attemptId,
              summary:
                'No recent agent output. Inspect the last operation or pause; the runtime limit still applies.',
              details: health.operation,
            });
          }
        }
        const state = automationState(this.store, task.id);
        if (
          state.enabled &&
          state.error &&
          state.errorContext &&
          state.errorContext !== taskContext(task)
        ) {
          state.error = null;
          state.errorContext = null;
          save(this.store, task.id, state);
        }
        if (
          !state.enabled ||
          state.error ||
          this.engine.running.has(task.id) ||
          this.engine.manualRuns.has(task.id) ||
          this.engine.actionLocks.has(task.id) ||
          this.isBusy(task.id)
        )
          continue;
        try {
          const parent = task.attempts.at(-1)?.id;
          if (task.status === 'awaiting_plan') {
            const plan = completedPlan(task);
            requireValue(
              plan?.recommendationReason?.trim() &&
                plan.options.some((o) => o.id === plan.recommendedOptionId),
              'Auto needs a structured planner recommendation. Choose an approach manually or request an updated plan.',
            );
            await this.engine.action(task.id, 'approve-plan', {
              optionId: plan.recommendedOptionId,
              note: `Auto: ${plan.recommendationReason}`,
              automation: { authorizationId: state.authorizationId, scope: state.scope },
            });
            this.receipt(
              task.id,
              state,
              `Recommended approach selected: ${plan.options.find((o) => o.id === plan.recommendedOptionId).title}. ${plan.recommendationReason}`,
              parent,
            );
          } else if (task.status === 'awaiting_final') {
            const review = task.attempts.findLast(
              (a) => a.stage === 'review' && a.role !== 'debug',
            );
            requireValue(
              (review?.status === 'complete' &&
                review.handoff?.verdict === 'complete' &&
                !review.handoff.findings.length &&
                task.verifiedFingerprint &&
                task.verifiedFingerprint === task.reviewedFingerprint) ||
                (task.demo &&
                  review?.status === 'complete' &&
                  review?.handoff?.verdict === 'complete' &&
                  !review.handoff.findings.length),
              'Auto requires current passing verification and a clean independent review.',
            );
            await this.engine.action(task.id, 'accept', {
              automation: { authorizationId: state.authorizationId, scope: state.scope },
            });
            this.receipt(
              task.id,
              state,
              'Accepted after passing verification and clean review.',
              parent,
            );
          } else if (
            task.status === 'blocked' &&
            task.blockerDecision?.kind === 'runtime_budget' &&
            !state.budgetContinued &&
            !task.loopGuard?.stopped
          ) {
            state.budgetContinued = true;
            save(this.store, task.id, state);
            await this.engine.action(task.id, 'resume', {
              automation: { authorizationId: state.authorizationId, scope: state.scope },
            });
            this.receipt(
              task.id,
              state,
              'Continued the saved session once after its runtime budget ended.',
              parent,
            );
          } else if (task.status === 'completed' && state.scope === 'draft_pr' && !task.demo) {
            const cycle = task.followUpContext?.id ?? 'initial';
            const receiptKey = (entry) => `${cycle}:${entry.repository.id}`;
            const entry = workspaces(task).find(
              (e) =>
                !state.publicationReceipts?.includes(receiptKey(e)) &&
                !(cycle === 'initial' && state.published?.includes(e.repository.id)),
            );
            if (entry) {
              const acceptedAt = task.approvals.findLast(
                (approval) => approval.type === 'final',
              )?.at;
              const sameCycle =
                entry.delivery?.automation?.cycle === cycle ||
                (acceptedAt && Date.parse(entry.delivery?.startedAt) >= Date.parse(acceptedAt));
              if (sameCycle && entry.delivery?.status === 'complete') {
                state.publicationReceipts = [
                  ...(state.publicationReceipts ?? []),
                  receiptKey(entry),
                ];
                save(this.store, task.id, state);
                continue;
              }
              requireValue(
                !sameCycle ||
                  !['blocked', 'interrupted', 'running'].includes(entry.delivery?.status),
                'Inspect the existing publication attempt before retrying. Auto will not repeat an uncertain remote action.',
              );
              await this.publication.start(task.id, entry.repository.id, {
                automation: { authorizationId: state.authorizationId, scope: state.scope, cycle },
              });
              // Preflight failures do not consume the receipt. Started/uncertain runs are guarded above.
              if (automationState(this.store, task.id).authorizationId === state.authorizationId) {
                state.publicationReceipts = [
                  ...(state.publicationReceipts ?? []),
                  receiptKey(entry),
                ];
                save(this.store, task.id, state);
              }
              this.receipt(
                task.id,
                state,
                `Draft PR publication delegated for ${entry.repository.name}.`,
                parent,
              );
            }
          }
        } catch (error) {
          if (automationState(this.store, task.id).authorizationId === state.authorizationId) {
            state.error = error.message;
            state.errorContext = taskContext(this.store.get(task.id));
            save(this.store, task.id, state);
          }
          this.store.event(task.id, {
            type: 'automation',
            summary: `Auto needs attention: ${error.message}`,
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
