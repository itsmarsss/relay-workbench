import { Icon } from './UI';
import { taskLane } from './board';
import {
  ago,
  decisionLabel,
  repositoryNames,
  stageNames,
  ticketRef,
  waitingKind,
} from './presentation';
import type { Task } from './types';

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

// One row per decision: why it stopped, where, what it says, and what you are asked to do.
export function AttentionList({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  return (
    <div className="attention-list">
      {tasks.map((task) => (
        <button
          className="attention-row"
          data-lane={taskLane(task)}
          key={task.id}
          onClick={() => onOpen(task)}
        >
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
              <span className="attention-reason">{task.error || task.latestSummary}</span>
            )}
          </span>
          <span className="attention-action">
            {decisionLabel(task)}
            <Icon name="arrow" size={15} />
          </span>
        </button>
      ))}
    </div>
  );
}
