import { Icon } from './UI';
import { taskLane } from './board';
import {
  ago,
  decisionLabel,
  plainSummary,
  repositoryNames,
  stageNames,
  ticketRef,
  waitingKind,
} from './presentation';
import type { Task } from './types';
import { useEffect, useState } from 'react';
import { request, useSession } from './Session';
import { asText, latestPlan } from './task-data';

export function TaskFacts({ task, lead }: { task: Task; lead?: string }) {
  const ref = ticketRef(task.ticket);
  return (
    <span className="overview-facts">
      {lead && <span>{lead}</span>}
      <span>{repositoryNames(task)}</span>
      {ref && <span className="overview-ref">{ref}</span>}
    </span>
  );
}

// A plan waiting for approval can be approved from the list, choosing what the planner
// recommends, without opening the task. Opening it shows every option first.
export function QuickApprove({
  task,
  className = 'primary attention-quick',
  label = 'Approve recommended',
}: {
  task: Task;
  className?: string;
  label?: string;
}) {
  const { bootstrap } = useSession();
  const [plan, setPlan] = useState<{
      option: string;
      title: string;
      attempt: string;
      revision: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void request<Record<string, unknown>>(`/api/tasks/${task.id}`)
      .then((full) => {
        const current = latestPlan(full);
        const option = current?.options.find((item) => item.id === current.recommendedId);
        if (alive && current && option)
          setPlan({
            option: option.id,
            title: option.title,
            attempt: current.attemptId,
            revision: asText(full.taskRevision),
          });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [task.id, task.updatedAt]);
  if (!plan) return null;
  return (
    <button
      type="button"
      className={className}
      disabled={busy || !bootstrap}
      title={error || `Approve “${plan.title}”, the recommended approach`}
      onClick={() => {
        setBusy(true);
        setError('');
        void request(`/api/tasks/${task.id}/approve-plan`, bootstrap?.token, {
          optionId: plan.option,
          planAttemptId: plan.attempt,
          taskRevision: plan.revision,
        })
          .then(() => window.dispatchEvent(new Event('relay-data-change')))
          .catch((failure) =>
            setError(failure instanceof Error ? failure.message : 'Could not approve.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Approving…' : error ? 'Try again' : label}
    </button>
  );
}

// One row per decision: why it stopped, where, what it says, and what you are asked to do.
export function AttentionList({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  return (
    <div className="attention-list">
      {tasks.map((task) => (
        <div className="attention-item" key={task.id}>
          <button className="attention-row" data-lane={taskLane(task)} onClick={() => onOpen(task)}>
            <span className="attention-main">
              <span className="attention-meta">
                <span className="attention-kind">
                  {waitingKind(task)}
                  {stageNames[task.stage || ''] && ` · ${stageNames[task.stage || '']}`}
                </span>
                <TaskFacts task={task} />
                <time>{ago(task.updatedAt)}</time>
              </span>
              <strong>{task.title}</strong>
              {(task.error || task.latestSummary) && (
                <span className="attention-reason">
                  {plainSummary(task.error || task.latestSummary)}
                </span>
              )}
            </span>
            <span className="attention-action">
              {decisionLabel(task)}
              <Icon name="arrow" size={15} />
            </span>
          </button>
          {task.status === 'awaiting_plan' && <QuickApprove task={task} />}
        </div>
      ))}
    </div>
  );
}
