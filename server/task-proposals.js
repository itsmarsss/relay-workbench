import { automationState } from './workflow-automation.js';
import {
  validateWorkspaceAction,
  applyWorkspaceAction,
  taskSettingFields,
} from './workspace-task-actions.js';
import { randomUUID, createHash } from 'node:crypto';
import { requireValue, text, reconfigureTask } from './domain.js';
import { configurationProposals } from './workspace-permissions.js';
import { workspaces } from './task-repositories.js';
const key = 'workspace-task-proposals';
export function taskProposals(store) {
  const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : [];
}
function save(store, values) {
  store.db
    .prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
    .run(key, JSON.stringify(values));
  store.notify({ type: 'workspace_permission', taskId: '' });
}
function saveProposal(store, proposal) {
  save(
    store,
    taskProposals(store).map((p) => (p.id === proposal.id ? proposal : p)),
  );
}
export function recoverTaskProposals(store) {
  const proposals = taskProposals(store);
  let changed = false;
  for (const proposal of proposals)
    if (proposal.status === 'applying') {
      proposal.status = 'failed';
      proposal.error =
        'Relay restarted while applying this request. Inspect current task state before proposing it again.';
      changed = true;
    }
  if (changed) save(store, proposals);
}
function currentSetting(task, key) {
  if (key === 'repositoryId') return task.repository.id;
  if (key === 'repositoryIds') return workspaces(task).map((e) => e.repository.id);
  if (key === 'repositorySettings')
    return workspaces(task).map(({ repository: r }) => ({
      id: r.id,
      cwd: r.cwd,
      checks: r.checks,
      setup: r.setup,
      instructions: r.instructions,
      verificationMode: r.verificationMode,
    }));
  return task[key] ?? null;
}
const fingerprint = (task, store) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        task.configRevision ?? 0,
        task.status,
        task.attempts.at(-1)?.id,
        task.preset,
        task.routing,
        task.models,
        task.execution,
        task.messages,
        task.reviewComments,
        task.blockerDecision,
        task.chosenApproach,
        task.verifiedFingerprint,
        task.reviewedFingerprint,
        [
          automationState(store, task.id).authorizationId,
          automationState(store, task.id).enabled,
          automationState(store, task.id).scope,
        ],
        store.config,
        workspaces(task).map((e) => [
          e.repository.id,
          e.publication?.url,
          e.publication?.state,
          e.feedbackAutopilot?.enabled,
          e.publicationMonitor?.enabled,
          e.delivery?.id,
          e.delivery?.status,
        ]),
      ]),
    )
    .digest('hex');
function validate(store, change) {
  const operations = {
    settings: ['settings'],
    feedback: ['repositoryId', 'enabled'],
    automation: ['enabled', 'scope'],
    checkpoint: ['checkpointId', 'stage', 'note'],
    workflow: ['action', 'data'],
    publish: ['repositoryId', 'request'],
    monitor: ['repositoryId', 'enabled'],
  };
  const allowed =
    typeof change.operation === 'string' && Object.hasOwn(operations, change.operation)
      ? operations[change.operation]
      : null;
  requireValue(
    allowed &&
      Object.keys(change).every((k) =>
        ['taskId', 'operation', 'title', 'base', 'before', 'effects', ...allowed].includes(k),
      ),
    'Unsupported task change fields',
  );
  const task = store.get(text(change.taskId, 'Task ID', 100));
  requireValue(task, 'Task not found', 404);
  if (change.operation === 'settings') {
    requireValue(
      change.settings &&
        typeof change.settings === 'object' &&
        !Array.isArray(change.settings) &&
        Object.keys(change.settings).length &&
        Object.keys(change.settings).every((k) => taskSettingFields.includes(k)),
      'Only supported task settings can be proposed',
    );
    const settings = structuredClone(change.settings);
    for (const field of ['routing', 'models', 'execution'])
      if (Object.hasOwn(settings, field)) {
        requireValue(
          settings[field] && typeof settings[field] === 'object' && !Array.isArray(settings[field]),
          'Choose valid per-stage settings',
        );
        settings[field] = { ...task[field], ...settings[field] };
      }
    const result = reconfigureTask(
      structuredClone(task),
      { ...settings, expectedRevision: task.configRevision ?? 0 },
      store.config,
    );
    return { task, candidate: result.task, settings };
  }
  if (change.operation !== 'feedback')
    return { task, ...validateWorkspaceAction(store, task, change) };
  const entry = workspaces(task).find((e) => e.repository.id === change.repositoryId);
  requireValue(
    typeof change.enabled === 'boolean' && entry,
    'Choose a repository and feedback state',
  );
  requireValue(
    !change.enabled ||
      (task.status === 'completed' &&
        !task.demo &&
        task.preset !== 'investigate' &&
        entry.publication?.state === 'open'),
    'Feedback requires an accepted task with an open PR',
    409,
  );
  requireValue(
    !change.enabled ||
      !workspaces(task).some(
        (e) => e.submission?.status === 'running' || e.delivery?.status === 'running',
      ),
    'Wait for publication before enabling feedback',
    409,
  );
  return { task, entry };
}
export function proposeTaskChanges(store, changes, reason, messageId) {
  requireValue(
    store.config.workspaceAgent.permissions.readSettings,
    'Read settings permission is required',
    403,
  );
  requireValue(
    store.config.workspaceAgent.permissions.proposeTasks,
    'Task proposals permission is disabled',
    403,
  );
  requireValue(
    Array.isArray(changes) && changes.length > 0 && changes.length <= 30,
    'Propose between 1 and 30 task changes',
  );
  requireValue(
    new Set(changes.map((c) => c?.taskId)).size === changes.length,
    'Propose each task once',
  );
  requireValue(
    changes.every((c) => c && typeof c === 'object' && !Array.isArray(c)),
    'Invalid task change',
  );
  requireValue(
    changes.length === 1 || changes.every((c) => ['settings', 'feedback'].includes(c.operation)),
    'Propose execution actions one at a time',
  );
  const reviewed = changes.map((change) => {
    const { task, candidate, entry, settings, before } = validate(store, change);
    return {
      ...structuredClone(change),
      ...(settings ? { settings } : {}),
      title: task.title,
      effects: candidate
        ? {
            status: candidate.status,
            stage: candidate.stage,
            approachApprovalReset: !!task.chosenApproach && !candidate.chosenApproach,
          }
        : undefined,
      base: fingerprint(task, store),
      before: candidate
        ? Object.fromEntries(Object.keys(change.settings).map((k) => [k, currentSetting(task, k)]))
        : (before ?? { enabled: entry.feedbackAutopilot?.enabled ?? false }),
    };
  });
  const all = taskProposals(store);
  requireValue(
    all.filter((p) => p.status === 'pending').length < 20,
    'Review pending task changes first',
    409,
  );
  const proposal = {
    id: randomUUID(),
    messageId,
    reason: text(reason, 'Reason', 2000),
    changes: reviewed,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  save(store, [
    ...all.filter((p) => p.status === 'pending'),
    ...all.filter((p) => p.status !== 'pending').slice(-79),
    proposal,
  ]);
  return {
    id: proposal.id,
    status: proposal.status,
    reason: proposal.reason,
    changes: reviewed.map(({ base, ...c }) => c),
    message:
      'Nothing changed yet. The human can approve this exact request in chat, or reply yes when this is the latest single pending task request.',
  };
}
export async function decideTaskProposal(
  store,
  engine,
  feedback,
  monitor,
  id,
  decision,
  busy = () => false,
  services = {},
) {
  requireValue(['approve', 'reject'].includes(decision), 'Choose approve or reject');
  const all = taskProposals(store),
    proposal = all.find((p) => p.id === id);
  requireValue(proposal?.status === 'pending', 'Task request changed; refresh', 409);
  if (decision === 'approve') {
    requireValue(
      store.config.workspaceAgent.permissions.readSettings,
      'Read settings permission is required',
      403,
    );
    requireValue(
      store.config.workspaceAgent.permissions.proposeTasks,
      'Task proposals permission is disabled',
      403,
    );
    // Validate the whole batch before the first mutation. Execution requests are single-task.
    for (const change of proposal.changes) {
      const { task } = validate(store, change);
      requireValue(
        fingerprint(task, store) === change.base,
        'Task changed since this request; ask Relay for a fresh proposal',
        409,
      );
      const mayInterrupt =
        change.operation === 'workflow' && ['pause', 'cancel'].includes(change.action);
      const onlyDelegation = ['automation', 'checkpoint'].includes(change.operation);
      requireValue(
        (change.operation === 'automation' || !engine.actionLocks.has(task.id)) &&
          (mayInterrupt ||
            onlyDelegation ||
            (!engine.running.has(task.id) &&
              !engine.manualRuns.has(task.id) &&
              !feedback.jobs.has(task.id) &&
              !busy(task.id))) &&
          !engine.stopping &&
          (change.operation === 'automation' ||
            !task.recoveryNotBefore ||
            Date.now() >= task.recoveryNotBefore),
        'Wait for active task work before applying changes',
        409,
      );
    }
    proposal.status = 'applying';
    save(store, all);
    try {
      for (const change of proposal.changes) {
        if (change.operation === 'settings')
          engine.update(change.taskId, {
            ...change.settings,
            expectedRevision: store.get(change.taskId).configRevision ?? 0,
          });
        else if (change.operation === 'feedback') {
          feedback.configure(change.taskId, change.repositoryId, change.enabled);
          if (
            change.enabled &&
            !workspaces(store.get(change.taskId)).find(
              (e) => e.repository.id === change.repositoryId,
            ).publicationMonitor?.enabled
          )
            monitor.configure(change.taskId, change.repositoryId, true);
        } else {
          const result = await applyWorkspaceAction(store, engine, monitor, services, change);
          (proposal.results ??= []).push({
            taskId: change.taskId,
            operation: change.operation,
            ...result,
          });
        }
      }
    } catch (error) {
      proposal.status = 'failed';
      proposal.error = error.message;
      proposal.decidedAt = new Date().toISOString();
      saveProposal(store, proposal);
      throw error;
    }
  }
  proposal.status = decision === 'approve' ? 'approved' : 'rejected';
  proposal.decidedAt = new Date().toISOString();
  saveProposal(store, proposal);
  return { status: proposal.status, results: proposal.results ?? [] };
}
export function latestTaskConfirmation(store, history, question) {
  if (!/^(yes|approve|go ahead|do it)[.!]?$/i.test(question.trim())) return null;
  if (configurationProposals(store).some((p) => p.status === 'pending')) return null;
  const last = history.at(-1);
  if (last?.status !== 'complete') return null;
  const pending = taskProposals(store).filter((p) => p.status === 'pending');
  return pending.length === 1 && pending[0].messageId === last.id ? pending[0] : null;
}
