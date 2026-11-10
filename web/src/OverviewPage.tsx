import { useEffect, useState } from 'react';
import { Icon, ProviderIcon, RelayMark, providerName } from './UI';
import { inTaskScope, taskLane } from './board';
import { AttentionList, TaskFacts } from './AttentionList';
import { ago, stageNames } from './presentation';
import { isLive, runTime } from './TaskMonitor';
import { statusLabel, type Task } from './types';

const newest = (a: Task, b: Task) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
export function OverviewPage({
  tasks,
  loading,
  onNavigate,
  onCreate,
}: {
  tasks: Task[];
  loading: boolean;
  onNavigate: (hash: string) => void;
  onCreate: () => void;
}) {
  const waiting = tasks.filter((task) => inTaskScope(task, 'attention')).sort(newest);
  const active = tasks.filter((task) => inTaskScope(task, 'active')).sort(newest);
  const backlog = tasks.filter((task) => taskLane(task) === 'backlog').sort(newest);
  const finished = tasks
    .filter((task) => ['done', 'finished'].includes(taskLane(task)))
    .sort(newest);
  const [now, setNow] = useState(() => Date.now());
  const live = active.some(isLive);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const approvals = waiting.filter((task) =>
    ['awaiting_plan', 'awaiting_final'].includes(task.status),
  ).length;
  const runningStages = [
    ...new Set(
      active.map((task) => stageNames[task.currentRun?.stage || task.stage || ''] || 'Queued'),
    ),
  ];
  const stats = [
    {
      scope: 'attention',
      count: waiting.length,
      label: 'Need you',
      detail: waiting.length
        ? [
            approvals && plural(approvals, 'approval', 'approvals'),
            waiting.length - approvals && `${waiting.length - approvals} stopped`,
          ]
            .filter(Boolean)
            .join(' · ')
        : 'Nothing is waiting on you',
      tone: waiting.length ? 'attention' : '',
    },
    {
      scope: 'active',
      count: active.length,
      label: 'Running',
      detail: active.length
        ? runningStages.length > 2
          ? `Across ${runningStages.length} stages`
          : runningStages.join(', ')
        : 'No agents working',
      tone: active.length ? 'running' : '',
    },
    {
      scope: 'backlog',
      count: backlog.length,
      label: 'Backlog',
      detail: backlog.length ? 'Ready to start' : 'Nothing queued up',
      tone: '',
    },
    {
      scope: 'done',
      count: finished.length,
      label: 'Done',
      detail: finished.length
        ? `Latest ${ago(finished[0]?.updatedAt).toLowerCase()}`
        : 'Nothing yet',
      tone: '',
    },
  ];
  const open = (task: Task) => onNavigate(`#task/${task.id}/overview`);
  return (
    <section className="overview-page" aria-busy={loading}>
      <div className="overview-heading">
        <h1>{greeting}</h1>
      </div>
      <div className="overview-stats" role="group" aria-label="Workspace summary">
        {stats.map((stat) => (
          <button
            key={stat.scope}
            className="overview-stat"
            data-tone={stat.tone || undefined}
            onClick={() => onNavigate(`#tasks?scope=${stat.scope}`)}
          >
            <span className="overview-stat-label">{stat.label}</span>
            <strong>{loading ? '–' : stat.count}</strong>
            <small>{loading ? 'Loading…' : stat.detail}</small>
          </button>
        ))}
      </div>
      {!!waiting.length && (
        <section className="overview-section" aria-labelledby="needs-you-heading">
          <div className="section-heading">
            <h2 id="needs-you-heading">
              Needs you <span className="count-chip">{waiting.length}</span>
            </h2>
            <button className="text-button" onClick={() => onNavigate('#inbox')}>
              Approval inbox
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <AttentionList tasks={waiting} onOpen={open} />
        </section>
      )}
      {!!active.length && (
        <section className="overview-section" aria-labelledby="running-heading">
          <div className="section-heading">
            <h2 id="running-heading">
              Running now <span className="count-chip">{active.length}</span>
            </h2>
            <button className="text-button" onClick={() => onNavigate('#deck')}>
              Task deck
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="quiet-list">
            {active.map((task) => {
              const stage = task.currentRun?.stage || task.stage || '';
              const time = runTime(task, now);
              const model = task.currentRun?.actualModel || task.currentRun?.model;
              return (
                <button className="quiet-row running-row" key={task.id} onClick={() => open(task)}>
                  <span className={`live-dot ${isLive(task) ? 'is-live' : ''}`} />
                  <span className="quiet-copy">
                    <strong>{task.title}</strong>
                    <TaskFacts task={task} lead={stageNames[stage] || statusLabel(task.status)} />
                  </span>
                  <span className="quiet-agent">
                    {task.currentRun?.harness && (
                      <>
                        <ProviderIcon provider={task.currentRun.harness} size={18} />
                        <span>
                          {providerName(task.currentRun.harness)}
                          {model && ` · ${model}`}
                        </span>
                      </>
                    )}
                  </span>
                  <time>{time ? time.label : ago(task.updatedAt)}</time>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {tasks.length ? (
        <div className="overview-columns">
          <section className="overview-section" aria-labelledby="backlog-heading">
            <div className="section-heading">
              <h2 id="backlog-heading">
                Up next <span className="count-chip">{backlog.length}</span>
              </h2>
              <button className="text-button" onClick={() => onNavigate('#tasks?scope=backlog')}>
                Backlog
                <Icon name="arrow" size={16} />
              </button>
            </div>
            {backlog.length ? (
              <div className="quiet-list">
                {backlog.slice(0, 8).map((task) => (
                  <button className="quiet-row" key={task.id} onClick={() => open(task)}>
                    <span className="quiet-copy">
                      <strong>{task.title}</strong>
                      <TaskFacts task={task} lead="Not started" />
                    </span>
                    <time>{ago(task.updatedAt)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <p className="overview-empty">
                Nothing is queued up.{' '}
                <button className="text-button" onClick={onCreate}>
                  New task
                </button>
              </p>
            )}
          </section>
          <section className="overview-section" aria-labelledby="finished-heading">
            <div className="section-heading">
              <h2 id="finished-heading">
                Recently finished <span className="count-chip">{finished.length}</span>
              </h2>
              <button className="text-button" onClick={() => onNavigate('#tasks?scope=done')}>
                All finished
                <Icon name="arrow" size={16} />
              </button>
            </div>
            {finished.length ? (
              <div className="quiet-list">
                {finished.slice(0, 8).map((task) => (
                  <button className="quiet-row" key={task.id} onClick={() => open(task)}>
                    <span className="quiet-copy">
                      <strong>{task.title}</strong>
                      <TaskFacts task={task} lead={statusLabel(task.status)} />
                      {task.latestSummary && (
                        <span className="quiet-summary">{task.latestSummary}</span>
                      )}
                    </span>
                    <time>{ago(task.updatedAt)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <p className="overview-empty">Accepted work will appear here.</p>
            )}
          </section>
        </div>
      ) : (
        !loading && (
          <div className="welcome-card">
            <RelayMark size={56} />
            <h2>Your next task has a whole team behind it.</h2>
            <p>
              Investigation, thoughtful design, implementation, and an independent review —
              connected by one clear thread.
            </p>
            <button className="primary" onClick={onCreate}>
              Create your first task
            </button>
            <small>You approve the approach. You have the final say.</small>
          </div>
        )
      )}
    </section>
  );
}
