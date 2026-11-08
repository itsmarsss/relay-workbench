import { randomUUID, createHash } from 'node:crypto';
import { requireValue, text, reconfigureTask } from './domain.js';
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
const fingerprint = (task) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        task.configRevision ?? 0,
        task.status,
        task.attempts.at(-1)?.id,
        task.preset,
        task.routing,
        task.models,
        workspaces(task).map((e) => [
          e.repository.id,
          e.publication?.url,
          e.publication?.state,
          e.feedbackAutopilot?.enabled,
        ]),
      ]),
    )
    .digest('hex');
function validate(store, change) {
  const task = store.get(text(change.taskId, 'Task ID', 100));
  requireValue(task, 'Task not found', 404);
  if (change.operation === 'settings') {
    requireValue(
      task.status === 'draft' &&
        !task.attempts.length &&
        workspaces(task).every((e) => !e.workspaceRoot && !e.baseCommit),
      'Only unstarted drafts can be configured from chat',
      409,
    );
    requireValue(
      change.settings &&
        Object.keys(change.settings).length &&
        Object.keys(change.settings).every((k) =>
          ['preset', 'routing', 'models', 'smartRouting'].includes(k),
        ),
      'Only workflow, routing and model settings can be proposed',
    );
    const settings = structuredClone(change.settings);
    for (const field of ['routing', 'models'])
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
  requireValue(change.operation === 'feedback', 'Unsupported task operation');
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
    new Set(changes.map((c) => c.taskId)).size === changes.length,
    'Propose each task once',
  );
  const reviewed = changes.map((change) => {
    const { task, candidate, entry, settings } = validate(store, change);
    return {
      ...structuredClone(change),
      ...(settings ? { settings } : {}),
      title: task.title,
      base: fingerprint(task),
      before: candidate
        ? Object.fromEntries(Object.keys(change.settings).map((k) => [k, task[k] ?? null]))
        : { enabled: entry.feedbackAutopilot?.enabled ?? false },
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
    // Validate the whole batch before the first mutation. Draft updates are synchronous.
    for (const change of proposal.changes) {
      const { task } = validate(store, change);
      requireValue(
        fingerprint(task) === change.base,
        'Task changed since this request; ask Relay for a fresh proposal',
        409,
      );
      requireValue(
        !engine.actionLocks.has(task.id) &&
          !engine.running.has(task.id) &&
          !engine.manualRuns.has(task.id) &&
          !feedback.jobs.has(task.id) &&
          !feedback.starting?.has(task.id) &&
          !busy(task.id) &&
          !engine.stopping &&
          (!task.recoveryNotBefore || Date.now() >= task.recoveryNotBefore),
        'Wait for active task work before applying changes',
        409,
      );
    }
    for (const change of proposal.changes) {
      if (change.operation === 'settings')
        engine.update(change.taskId, {
          ...change.settings,
          expectedRevision: store.get(change.taskId).configRevision ?? 0,
        });
      else {
        feedback.configure(change.taskId, change.repositoryId, change.enabled);
        if (change.enabled) monitor.configure(change.taskId, change.repositoryId, true);
      }
    }
  }
  proposal.status = decision === 'approve' ? 'approved' : 'rejected';
  proposal.decidedAt = new Date().toISOString();
  save(store, all);
  return { status: proposal.status };
}
export function latestTaskConfirmation(store, history, question) {
  if (!/^(yes|approve|go ahead|do it)[.!]?$/i.test(question.trim())) return null;
  const last = history.at(-1);
  if (last?.status !== 'complete') return null;
  const pending = taskProposals(store).filter((p) => p.status === 'pending');
  return pending.length === 1 && pending[0].messageId === last.id ? pending[0] : null;
}
