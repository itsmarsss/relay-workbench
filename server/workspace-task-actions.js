import { completedPlan } from '../public/workflow-plan.js';
import { requirePublicationPrerequisites } from './publication-prerequisites.js';
import { requireValue, text } from './domain.js';
import { automationState } from './workflow-automation.js';
import { checkpoints, forkCheckpoint } from './workflow-checkpoints.js';
import { workspaces } from './task-repositories.js';

export const workflowActions = [
  'start',
  'resume',
  'pause',
  'cancel',
  'debug',
  'resolve-blocker',
  'request-changes',
  'follow-up',
  'approve-plan',
  'accept',
];
export const taskSettingFields = [
  'preset',
  'routing',
  'models',
  'execution',
  'smartRouting',
  'title',
  'description',
  'ticket',
  'repositoryId',
  'repositoryIds',
  'dependencies',
  'repositorySettings',
];
export const workspaceCapabilities = {
  inspect: [
    'tasks',
    'activity',
    'diffs',
    'blockers',
    'approaches',
    'Auto',
    'checkpoints',
    'PRs',
    'monitoring',
    'feedback',
    'settings',
    'approved memory',
  ],
  propose: [
    'task settings',
    'Auto scope',
    'workflow actions',
    'checkpoint continuations',
    'publication',
    'PR monitoring',
    'PR feedback',
    'global configuration',
  ],
  approval:
    'Every proposed change requires separate authenticated human approval. Auto delegation is per task and explicitly scoped.',
  unavailable: [
    'approve own proposals',
    'merge PRs',
    'arbitrary shell or source writes',
    'delete tasks or worktrees',
    'restore backups',
    'edit browser-local appearance preferences',
    'edit memory or cosmetic board overrides through chat',
  ],
};
export function validateWorkspaceAction(store, task, change) {
  if (change.operation === 'automation') {
    requireValue(typeof change.enabled === 'boolean', 'Choose an Auto state');
    requireValue(['reviewed', 'draft_pr'].includes(change.scope), 'Choose an Auto scope');
    requireValue(
      !change.enabled || !['cancelled'].includes(task.status),
      'Cancelled tasks cannot enable Auto',
      409,
    );
    return { before: automationState(store, task.id) };
  }
  requireValue(
    !task.checkpointRestore ||
      task.checkpointRestore.status === 'complete' ||
      (change.operation === 'workflow' && ['pause', 'cancel'].includes(change.action)),
    'Finish restoring the checkpoint before requesting agent actions',
    409,
  );
  if (change.operation === 'checkpoint') {
    const point = checkpoints(store, task.id).find((p) => p.id === change.checkpointId);
    requireValue(point, 'Checkpoint not found', 404);
    requireValue(
      ['saved', 'approach', 'decision', 'plan', 'implement', 'verify'].includes(change.stage),
      'Choose a continuation stage',
    );
    requireValue(
      change.stage !== 'approach' || point.approaches.length,
      'No saved approach choices',
    );
    requireValue(change.stage !== 'decision' || point.canChooseDebug, 'No debugger decision');
    requireValue(
      !['implement', 'verify'].includes(change.stage) || point.hasApproach,
      'Choose an approach first',
    );
    requireValue(
      !point.investigationOnly || ['saved', 'decision'].includes(change.stage),
      'Investigation-only checkpoints cannot start implementation',
    );
    text(change.note ?? '', 'Continuation note', 20000, true);
    return { before: { checkpoint: point, originalPreserved: true } };
  }
  if (change.operation === 'workflow') {
    requireValue(workflowActions.includes(change.action), 'Unsupported workflow action');
    const data = change.data ?? {};
    requireValue(data && typeof data === 'object' && !Array.isArray(data), 'Invalid action data');
    const fields =
      {
        'approve-plan': ['optionId', 'note'],
        'resolve-blocker': ['decisionId', 'resolution', 'optionId'],
        'request-changes': ['note'],
        'follow-up': ['message', 'provider', 'model', 'effort'],
      }[change.action] ?? [];
    requireValue(
      Object.keys(data).every((k) => fields.includes(k)),
      'Unsupported workflow action data',
    );
    const statuses = {
      start: ['draft'],
      resume: ['paused', 'blocked', 'interrupted'],
      debug: ['blocked'],
      'resolve-blocker': ['blocked'],
      'approve-plan': ['awaiting_plan'],
      accept: ['awaiting_final'],
      'request-changes': ['awaiting_plan', 'awaiting_final'],
      'follow-up': ['completed'],
    }[change.action];
    requireValue(
      statuses ? statuses.includes(task.status) : !['completed', 'cancelled'].includes(task.status),
      'Task is not ready for this action',
      409,
    );
    if (change.action === 'request-changes') text(data.note, 'Feedback', 20000);
    if (change.action === 'follow-up') text(data.message, 'Direction', 20000);
    for (const field of [
      'optionId',
      'note',
      'decisionId',
      'message',
      'provider',
      'model',
      'effort',
    ])
      if (Object.hasOwn(data, field))
        requireValue(typeof data[field] === 'string', 'Action values must be strings');
    if (['approve-plan', 'accept'].includes(change.action))
      requireValue(
        !task.messages.some((message) => message.delivery === 'pending'),
        'Process pending direction before approval',
        409,
      );
    if (change.action === 'approve-plan') {
      text(data.optionId, 'Approach ID', 200);
      requireValue(
        completedPlan(task)?.options?.some((option) => option.id === data.optionId),
        'Choose a current proposed approach',
      );
    }
    if (change.action === 'resolve-blocker')
      requireValue(
        !data.optionId?.startsWith('design-') || data.resolution === 'replan',
        'Design choices require a revised plan and approval',
      );
    if (change.action === 'resolve-blocker')
      requireValue(
        data.decisionId === task.blockerDecision?.id &&
          ['retry', 'replan', 'pause'].includes(data.resolution),
        'Choose a current blocker decision',
      );
    return {
      before: {
        status: task.status,
        stage: task.stage,
        chosenApproach: task.chosenApproach,
        selectedOption:
          change.action === 'approve-plan'
            ? completedPlan(task)?.options.find((option) => option.id === data.optionId)
            : null,
        blocker: task.blockerDecision,
        verified: task.verifiedFingerprint,
        reviewed: task.reviewedFingerprint,
      },
    };
  }
  requireValue(['publish', 'monitor'].includes(change.operation), 'Unsupported task operation');
  const entry = workspaces(task).find((e) => e.repository.id === change.repositoryId);
  requireValue(entry, 'Select a task repository');
  requireValue(
    task.status === 'completed' && !task.demo && task.preset !== 'investigate',
    'Accept a live implementation task first',
    409,
  );
  if (change.operation === 'monitor')
    requireValue(typeof change.enabled === 'boolean', 'Choose a monitoring state');
  if (change.operation === 'publish') {
    text(change.request ?? '', 'Publication request', 20000, true);
    requirePublicationPrerequisites(task, change.repositoryId);
  }
  return {
    before: {
      publication: entry.publication ?? null,
      delivery: entry.delivery?.status ?? null,
      monitor: entry.publicationMonitor?.enabled ?? false,
    },
  };
}
export async function applyWorkspaceAction(store, engine, monitor, services, change) {
  switch (change.operation) {
    case 'automation':
      requireValue(services.automation, 'Auto service unavailable', 503);
      return services.automation.configure(change.taskId, {
        enabled: change.enabled,
        scope: change.scope,
      });
    case 'checkpoint': {
      const task = await forkCheckpoint(store, change.taskId, change.checkpointId, {
        stage: change.stage,
        note: change.note ?? '',
      });
      return { taskId: task.id, url: `#task/${task.id}/overview`, status: task.status };
    }
    case 'workflow':
      await engine.action(change.taskId, change.action, change.data ?? {});
      return { taskId: change.taskId, status: store.get(change.taskId).status };
    case 'publish':
      requireValue(services.publication, 'Publication service unavailable', 503);
      await services.publication.start(change.taskId, change.repositoryId, {
        request: change.request,
      });
      return { taskId: change.taskId, status: 'publishing' };
    case 'monitor':
      monitor.configure(change.taskId, change.repositoryId, change.enabled);
      return { taskId: change.taskId, enabled: change.enabled };
  }
}
