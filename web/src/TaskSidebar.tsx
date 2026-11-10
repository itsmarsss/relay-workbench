import { useState } from 'react';
import { SideChat } from './Chat';
import { Modal } from './Modal';
import { ExecutionGraph, type FullTask } from './TaskExtras';
import { Icon, providerName } from './UI';
import { asObject, asText } from './task-data';
import { stageNames } from './presentation';
export function TaskSidebar({ task }: { task: FullTask }) {
  const [history, setHistory] = useState(false);
  const attempts = [
    ...(Array.isArray(task.attempts) ? task.attempts : []),
    ...(Array.isArray(task.deliveryRuns) ? task.deliveryRuns : []),
  ].map(asObject);
  const memories = Array.isArray(task.memorySnapshot) ? task.memorySnapshot : [];
  return (
    <aside className="task-sidebar" aria-label="Task context">
      <SideChat taskId={task.id} />
      <section className="surface task-memory-summary">
        <div className="section-heading">
          <h2>Memory</h2>
          <span>{memories.length} in latest run</span>
        </div>
        <p>
          {memories.length
            ? `${memories.length} approved memories supplied to this workflow.`
            : 'No memories included in the latest run.'}
        </p>
        <a href="#memory">
          Manage memory
          <Icon name="arrow" size={14} />
        </a>
      </section>
      <section className="surface workflow-sidebar">
        <div className="section-heading">
          <h2>Workflow</h2>
          <button
            className="text-button"
            aria-label="Execution history"
            onClick={() => setHistory(true)}
          >
            History
          </button>
        </div>
        <ol>
          {['triage', 'investigate', 'plan', 'implement', 'verify', 'review', 'publish'].map(
            (stage) => {
              const runs = attempts.filter((row) => row?.stage === stage && row?.role !== 'debug');
              const run = runs.at(-1),
                current = task.currentRun?.stage === stage && task.currentRun.status === 'running';
              const unused = stage === 'triage' && task.smartRouting !== true && !runs.length;
              const state = current
                ? 'running'
                : unused
                  ? 'skipped'
                  : asText(run?.status) || 'pending';
              const seconds = runs.reduce((total, row) => {
                const start = Date.parse(asText(row?.startedAt)),
                  end =
                    row?.status === 'running' ? Date.now() : Date.parse(asText(row?.finishedAt));
                return (
                  total +
                  (Number.isFinite(start) && Number.isFinite(end)
                    ? Math.max(0, (end - start) / 1000)
                    : 0)
                );
              }, 0);
              const duration =
                seconds >= 60
                  ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
                  : seconds > 0
                    ? `${Math.floor(seconds)}s`
                    : '';
              return (
                <li key={stage} className={`workflow-step step-${state}`}>
                  <span className="workflow-step-dot">
                    {state === 'complete' ? (
                      <Icon name="check" size={12} />
                    ) : unused ? (
                      <Icon name="minus" size={10} />
                    ) : current ? (
                      <span className="working-dot" />
                    ) : stage === 'publish' ? (
                      7
                    ) : (
                      ['triage', 'investigate', 'plan', 'implement', 'verify', 'review'].indexOf(
                        stage,
                      ) + 1
                    )}
                  </span>
                  <button onClick={() => setHistory(true)}>
                    <span>
                      <strong>{stageNames[stage]}</strong>
                      <small>
                        {state === 'complete'
                          ? 'Complete'
                          : current
                            ? task.currentRun?.role === 'debug'
                              ? 'Debugging'
                              : 'Running'
                            : unused
                              ? 'Not used'
                              : state === 'pending'
                                ? 'Pending'
                                : state.replaceAll('_', ' ')}
                      </small>
                    </span>
                    {run?.harness ? (
                      <span className="workflow-step-agent">
                        <span>
                          {providerName(asText(run.harness))}
                          {duration && ` · ${duration}`}
                        </span>
                        {runs.length > 1 && <small>{runs.length} runs</small>}
                      </span>
                    ) : (
                      <span className="workflow-step-agent">
                        {unused
                          ? 'Configured routing'
                          : stage === 'publish'
                            ? 'After acceptance'
                            : 'Not started'}
                      </span>
                    )}
                  </button>
                </li>
              );
            },
          )}
        </ol>
        {!!attempts.filter((row) => row?.role === 'debug').length && (
          <button className="text-button diagnostic-history" onClick={() => setHistory(true)}>
            Debugger history
            <Icon name="arrow" size={14} />
          </button>
        )}
      </section>
      {history && (
        <Modal
          title="Execution history"
          className="execution-map-modal"
          onClose={() => setHistory(false)}
        >
          <ExecutionGraph task={task} />
        </Modal>
      )}
    </aside>
  );
}
