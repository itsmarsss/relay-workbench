import { Icon, ProviderIcon } from './UI';
import { TaskPicker } from './TaskPicker';
import { ago, currentStage, nextStep, stageNames } from './presentation';
import { statusLabel, type Task, type TaskView } from './types';
import { columns, taskLane } from './board';
import { isLive, needsDecision, type Pane } from './deck';

export { isLive, needsDecision };
export function runTime(task: Task, now: number) {
  const start = Date.parse(task.currentRun?.startedAt || '');
  if (!isLive(task) || !Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return {
    seconds,
    label:
      seconds < 60
        ? `${seconds}s`
        : seconds < 3600
          ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
          : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`,
  };
}
export function TaskMonitor({
  node,
  number,
  task,
  tasks,
  editing,
  now,
  onChange,
  onExpand,
  onRemove,
  onDrag,
  onDrop,
  onMove,
}: {
  node: Pane;
  number: number;
  task?: Task;
  tasks: Task[];
  editing: boolean;
  now: number;
  onChange: (taskId: string) => void;
  onExpand: (view: TaskView) => void;
  onRemove: () => void;
  onDrag: (id: string) => void;
  onDrop: (id: string) => void;
  onMove: (offset: number) => void;
}) {
  const time = task ? runTime(task, now) : null;
  const stage = currentStage(task);
  const repositories = task?.repositories?.length
    ? task.repositories
        .map((row) => row.repository?.name)
        .filter(Boolean)
        .join(' + ')
    : task?.repository?.name;
  return (
    <article
      className={`monitor-tile ${editing ? 'is-editing' : ''} ${!task ? 'is-empty' : ''} ${task && needsDecision(task) ? 'needs-decision' : ''}`}
      aria-label={`Task tile ${number}: ${task?.title || 'Choose a task'}`}
      data-status={task?.status}
      onDragOver={(event) => {
        if (editing) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(event) => {
        if (editing) {
          event.preventDefault();
          onDrop(node.id);
        }
      }}
    >
      {(editing || !task) && (
        <div className="monitor-editbar">
          {editing && (
            <button
              className="icon-button monitor-grip"
              draggable
              aria-label={`Reorder pane ${number}`}
              title="Drag to reorder · arrow keys to move"
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', node.id);
                event.dataTransfer.effectAllowed = 'move';
                onDrag(node.id);
              }}
              onDragEnd={() => onDrag('')}
              onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
                  event.preventDefault();
                  onMove(['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
                }
              }}
            >
              <Icon name="grip" size={14} />
            </button>
          )}
          <TaskPicker
            id={node.id}
            label={`Task for pane ${number}`}
            tasks={tasks}
            selected={node.taskId}
            onChange={onChange}
          />
          {editing && (
            <button
              className="icon-button"
              aria-label="Close pane"
              title="Remove from grid"
              onClick={onRemove}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      )}
      {task && (
        <>
          <div className="monitor-state">
            <span className={`monitor-status ${isLive(task) ? 'is-live' : ''}`}>
              <span className="monitor-dot" aria-hidden="true" />
              {/* A task moved by hand on the board carries that column's name here too. */}
              {task.statusOverride
                ? columns.find((row) => row[0] === taskLane(task))?.[1] || statusLabel(task.status)
                : statusLabel(task.status)}
            </span>
            <span className="monitor-repository" title={repositories}>
              {repositories || 'Unspecified'}
            </span>
          </div>
          <button
            className="monitor-task-title"
            onClick={() => onExpand('overview')}
            title={task.title}
          >
            {task.title}
          </button>
          <p
            className={`monitor-update ${task.error ? 'has-error' : ''}`}
            title={task.error || task.latestSummary || nextStep(task)}
          >
            {task.error || task.latestSummary || nextStep(task)}
          </p>
          <footer className="monitor-footer">
            <span
              className="monitor-run"
              title={
                task.currentRun?.harness
                  ? `${stageNames[stage] || stage} · ${task.currentRun.harness}`
                  : undefined
              }
            >
              {task.currentRun?.harness && (
                <ProviderIcon provider={task.currentRun.harness} size={17} />
              )}
              <span>{stageNames[stage] || stage || 'Not started'}</span>
            </span>
            <time
              className="monitor-time"
              data-seconds={time?.seconds}
              data-live={!!time}
              aria-label={time ? 'Run time' : 'Last update'}
            >
              {time?.label || ago(task.updatedAt)}
            </time>
            <div className="monitor-actions">
              {(
                [
                  ['thread', 'chat', 'Activity'],
                  ['terminals', 'terminal', 'Terminal'],
                  ['diff', 'code', 'Changes'],
                ] as const
              ).map(([view, icon, label]) => (
                <button
                  key={view}
                  className="icon-button"
                  aria-label={`${label}: ${task.title}`}
                  title={label}
                  onClick={() => onExpand(view)}
                >
                  <Icon name={icon} size={14} />
                </button>
              ))}
            </div>
          </footer>
        </>
      )}
    </article>
  );
}
