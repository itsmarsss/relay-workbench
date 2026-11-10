import { useState } from 'react';
import { SideChat } from './Chat';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { ExecutionGraph, type FullTask } from './TaskExtras';
import { CopyButton, Icon, providerName } from './UI';
import { asObject, asText, type ObjectValue } from './task-data';
import { shortDate, stageNames } from './presentation';

const stages = ['triage', 'investigate', 'plan', 'implement', 'verify', 'review', 'publish'];
type Run = ObjectValue | null;
// A run that finished without doing its job is not "complete" to the person reading the list.
function runState(run: Run): { key: string; label: string } {
  const verdict = asText(asObject(run?.handoff)?.verdict),
    status = asText(run?.status);
  if (status === 'running') return { key: 'running', label: 'Running' };
  if (status === 'queued') return { key: 'pending', label: 'Queued' };
  if (status === 'failed' || run?.error) return { key: 'failed', label: 'Failed' };
  if (verdict === 'blocked' || status === 'blocked') return { key: 'failed', label: 'Blocked' };
  if (['changes_requested', 'repair_requested'].includes(verdict))
    return { key: 'failed', label: 'Changes requested' };
  if (['interrupted', 'paused'].includes(status)) return { key: 'paused', label: 'Paused' };
  if (status === 'complete') return { key: 'complete', label: 'Complete' };
  return { key: 'pending', label: 'Pending' };
}
const memoryEntries = (value: unknown): unknown[] =>
  Array.isArray(value)
    ? value
    : Array.isArray(asObject(value)?.entries)
      ? (asObject(value)!.entries as unknown[])
      : [];
function Fact({ label, value, copy }: { label: string; value: string; copy?: string }) {
  return (
    <div className="task-fact">
      <dt>{label}</dt>
      <dd>
        <span title={copy || value}>{value}</span>
        {copy && <CopyButton text={copy} />}
      </dd>
    </div>
  );
}
function WorkspaceCard({ task }: { task: FullTask }) {
  const rows = (
    Array.isArray(task.repositories) && task.repositories.length ? task.repositories : [task]
  ).map(asObject);
  const imported = asText(asObject(task.migration)?.originalWorkspace);
  return (
    <section className="surface task-facts" aria-label="Workspace">
      <div className="section-heading">
        <h2>Workspace</h2>
      </div>
      {rows.map((row, index) => {
        const repository = asObject(row?.repository),
          strategy = asText(repository?.strategy),
          branch = asText(row?.branch) || asText(task.branch),
          directory = asText(row?.workspace) || asText(task.workspace) || imported,
          base = asText(row?.baseCommit) || asText(task.baseCommit);
        const needs = (Array.isArray(task.dependencies) ? task.dependencies : [])
          .map(asObject)
          .filter((edge) => edge?.repositoryId === repository?.id)
          .map((edge) =>
            asText(
              asObject(
                rows.find((other) => asObject(other?.repository)?.id === edge?.dependsOn)
                  ?.repository,
              )?.name,
            ),
          )
          .filter(Boolean);
        return (
          <dl key={asText(repository?.id) || index}>
            <Fact
              label="Repository"
              value={`${asText(repository?.name) || 'Unspecified'}${
                strategy
                  ? ` · ${strategy === 'attach' ? 'existing checkout' : strategy === 'managed' ? 'managed worktree' : 'isolated worktree'}`
                  : ''
              }`}
            />
            <Fact
              label="Branch"
              value={branch || 'Assigned when started'}
              copy={branch || undefined}
            />
            <Fact
              label={directory && directory === imported ? 'Original directory' : 'Directory'}
              value={directory || 'Created when started'}
              copy={directory || undefined}
            />
            {base && <Fact label="Base commit" value={base.slice(0, 10)} copy={base} />}
            {!!needs.length && <Fact label="Depends on" value={needs.join(', ')} />}
          </dl>
        );
      })}
    </section>
  );
}
export function TaskSidebar({ task }: { task: FullTask }) {
  const [history, setHistory] = useState(false);
  const attempts = [
    ...(Array.isArray(task.attempts) ? task.attempts : []),
    ...(Array.isArray(task.deliveryRuns) ? task.deliveryRuns : []),
  ].map(asObject);
  const snapshots = memoryEntries(task.memorySnapshot);
  const memories = snapshots.length
    ? snapshots
    : memoryEntries(attempts.findLast((run) => run?.memorySnapshot)?.memorySnapshot);
  const failed = attempts.filter((run) => runState(run).key === 'failed'),
    debugging = attempts.filter((run) => run?.role === 'debug');
  const settled = ['completed', 'finished', 'awaiting_final'].includes(task.status);
  const approach = asObject(task.chosenApproach),
    execution = asObject(task.execution);
  return (
    <aside className="task-sidebar" aria-label="Task context">
      <SideChat taskId={task.id} />
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
          {stages.map((stage, index) => {
            const runs = attempts.filter((row) => row?.stage === stage && row?.role !== 'debug');
            const run = runs.at(-1),
              current = task.currentRun?.stage === stage && task.currentRun.status === 'running';
            const unused = stage === 'triage' && task.smartRouting !== true && !runs.length;
            const state = current
              ? {
                  key: 'running',
                  label: task.currentRun?.role === 'debug' ? 'Debugging' : 'Running',
                }
              : unused
                ? { key: 'skipped', label: 'Not used' }
                : stage === 'plan' && task.status === 'awaiting_plan' && run
                  ? { key: 'waiting', label: 'Awaiting approval' }
                  : stage === 'publish' && run?.status === 'complete'
                    ? { key: 'complete', label: 'Published' }
                    : runState(run || null);
            const seconds = runs.reduce((total, row) => {
              const start = Date.parse(asText(row?.startedAt)),
                end = row?.status === 'running' ? Date.now() : Date.parse(asText(row?.finishedAt));
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
              <li key={stage} className={`workflow-step step-${state.key}`}>
                <span className="workflow-step-dot">
                  {state.key === 'complete' ? (
                    <Icon name="check" size={12} />
                  ) : state.key === 'failed' ? (
                    <Icon name="close" size={11} />
                  ) : unused ? (
                    <Icon name="minus" size={10} />
                  ) : current ? (
                    <span className="working-dot" />
                  ) : (
                    index + 1
                  )}
                </span>
                <button onClick={() => setHistory(true)}>
                  <span>
                    <strong>{stageNames[stage]}</strong>
                    <small>{state.label}</small>
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
                        : stage === 'verify'
                          ? 'Required checks'
                          : stage === 'publish'
                            ? 'After acceptance'
                            : 'Not started'}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
        {(!!failed.length || !!debugging.length) && (
          <details className="run-health">
            <summary>
              <span>
                {[
                  failed.length && `${failed.length} failed`,
                  debugging.length &&
                    `${debugging.length} debug ${debugging.length === 1 ? 'run' : 'runs'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <small>
                {settled ? 'Recovered' : task.status === 'running' ? 'Recovering' : 'Needs you'}
              </small>
            </summary>
            <ul>
              {failed.slice(-3).map((run, index) => (
                <li key={asText(run?.id) || index}>
                  <strong>
                    {run?.role === 'debug' ? 'Debugger' : stageNames[asText(run?.stage)] || 'Run'}
                  </strong>
                  <span>
                    {asText(asObject(run?.handoff)?.summary, 400) ||
                      asText(run?.error, 400) ||
                      'No summary recorded.'}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <button className="text-button diagnostic-history" onClick={() => setHistory(true)}>
          Execution graph and checkpoints
          <Icon name="arrow" size={14} />
        </button>
      </section>
      <WorkspaceCard task={task} />
      {asText(approach?.title) && (
        <section className="surface approved-approach" aria-label="Approved approach">
          <div className="section-heading">
            <h2>Approved approach</h2>
          </div>
          <strong>{asText(approach?.title)}</strong>
          {asText(approach?.description) && (
            <details>
              <summary>Description and tradeoffs</summary>
              <Markdown text={asText(approach?.description)} />
              {asText(approach?.tradeoffs) && <Markdown text={asText(approach?.tradeoffs)} />}
            </details>
          )}
        </section>
      )}
      <section className="surface task-memory-summary">
        <div className="section-heading">
          <h2>Memory</h2>
          <span>{memories.length} in latest run</span>
        </div>
        {memories.length ? (
          <details>
            <summary>
              {memories.length} approved {memories.length === 1 ? 'memory' : 'memories'} supplied
            </summary>
            <ul>
              {memories.slice(0, 20).map((entry, index) => (
                <li key={index}>{asText(asObject(entry)?.title) || 'Untitled memory'}</li>
              ))}
            </ul>
          </details>
        ) : (
          <p>No memories included in the latest run.</p>
        )}
        <a href="#memory">
          Manage memory
          <Icon name="arrow" size={14} />
        </a>
      </section>
      <section className="surface task-facts" aria-label="Task details">
        <div className="section-heading">
          <h2>Details</h2>
        </div>
        <dl>
          {shortDate(asText(task.createdAt)) && (
            <Fact label="Created" value={shortDate(asText(task.createdAt))} />
          )}
          {asText(task.preset) && <Fact label="Workflow" value={asText(task.preset)} />}
          <Fact label="Task ID" value={task.id.slice(0, 8)} copy={task.id} />
          {execution && (
            <Fact
              label="Limits"
              value={[
                execution.timeoutMinutes != null && `${Number(execution.timeoutMinutes)}m timeout`,
                execution.maxRepairRounds != null &&
                  `${Number(execution.maxRepairRounds)} repair rounds`,
                execution.maxRecoveryAttempts != null &&
                  `${Number(execution.maxRecoveryAttempts)} recoveries`,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          )}
        </dl>
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
