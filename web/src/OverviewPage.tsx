import { Fragment, useEffect, useState } from 'react';
import { Icon, ProviderIcon, RelayMark } from './UI';
import { inTaskScope, taskLane } from './board';
import { ago, nextStep, stageNames } from './presentation';
import { isLive, runTime } from './TaskMonitor';
import { statusLabel, type Task } from './types';

const repositoryNames = (task: Task) =>
  task.repositories?.length
    ? task.repositories
        .map((row) => row.repository?.name)
        .filter(Boolean)
        .join(' + ')
    : task.repository?.name || 'Unspecified';
const newest = (a: Task, b: Task) => (b.updatedAt || '').localeCompare(a.updatedAt || '');

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
  const backlog = tasks.filter((task) => taskLane(task) === 'backlog');
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
  const summary = [
    {
      scope: 'attention',
      text: waiting.length
        ? `${waiting.length} ${waiting.length === 1 ? 'task needs' : 'tasks need'} you`
        : 'Nothing needs you',
      tone: waiting.length ? 'attention' : '',
    },
    {
      scope: 'active',
      text: active.length ? `${active.length} running` : 'nothing running',
      tone: active.length ? 'running' : '',
    },
    { scope: 'backlog', text: `${backlog.length} in backlog`, tone: '' },
    { scope: 'done', text: `${finished.length} done`, tone: '' },
  ];
  const open = (task: Task) => onNavigate(`#task/${task.id}/overview`);
  return (
    <section className="overview-page" aria-busy={loading}>
      <div className="overview-heading">
        <h1>{greeting}</h1>
        <p className="overview-summary" aria-label="Workspace summary">
          {loading
            ? 'Loading your workspace…'
            : summary.map((item, index) => (
                <Fragment key={item.scope}>
                  {index > 0 && <span aria-hidden="true"> · </span>}
                  <button
                    className={`summary-link ${item.tone}`}
                    onClick={() => onNavigate(`#tasks?scope=${item.scope}`)}
                  >
                    {item.text}
                  </button>
                </Fragment>
              ))}
        </p>
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
          <div className="attention-list">
            {waiting.map((task) => (
              <button
                className="attention-row"
                data-lane={taskLane(task)}
                key={task.id}
                onClick={() => open(task)}
              >
                <span className="attention-main">
                  <span className="attention-meta">
                    <span className="attention-kind">{statusLabel(task.status)}</span>
                    <span>{repositoryNames(task)}</span>
                    <time>{ago(task.updatedAt)}</time>
                  </span>
                  <strong>{task.title}</strong>
                  {(task.error || task.latestSummary) && (
                    <span className="attention-reason">{task.error || task.latestSummary}</span>
                  )}
                </span>
                <span className="attention-action">
                  {nextStep(task)}
                  <Icon name="arrow" size={15} />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="overview-section" aria-labelledby="running-heading">
        <div className="section-heading">
          <h2 id="running-heading">
            Running now <span className="count-chip">{active.length}</span>
          </h2>
          {!!active.length && (
            <button className="text-button" onClick={() => onNavigate('#deck')}>
              Task deck
              <Icon name="arrow" size={16} />
            </button>
          )}
        </div>
        {active.length ? (
          <div className="quiet-list">
            {active.map((task) => {
              const stage = task.currentRun?.stage || task.stage || '';
              const time = runTime(task, now);
              return (
                <button className="quiet-row" key={task.id} onClick={() => open(task)}>
                  <span className={`live-dot ${isLive(task) ? 'is-live' : ''}`} />
                  <strong>{task.title}</strong>
                  <span className="quiet-detail">
                    {stageNames[stage] || statusLabel(task.status)}
                  </span>
                  <span className="quiet-detail">{repositoryNames(task)}</span>
                  <span className="quiet-end">
                    {task.currentRun?.harness && (
                      <ProviderIcon provider={task.currentRun.harness} size={18} />
                    )}
                    <time>{time ? time.label : ago(task.updatedAt)}</time>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="overview-empty">
            {backlog.length
              ? 'No agents are working. Start a backlog task when you are ready.'
              : 'No agents are working.'}
          </p>
        )}
      </section>
      {tasks.length ? (
        <section className="overview-section" aria-labelledby="finished-heading">
          <div className="section-heading">
            <h2 id="finished-heading">
              Recently finished <span className="count-chip">{finished.length}</span>
            </h2>
            <button className="text-button" onClick={() => onNavigate('#tasks')}>
              View all tasks
              <Icon name="arrow" size={16} />
            </button>
          </div>
          {finished.length ? (
            <div className="quiet-list">
              {finished.slice(0, 6).map((task) => (
                <button className="quiet-row" key={task.id} onClick={() => open(task)}>
                  <Icon name="check" size={15} />
                  <strong>{task.title}</strong>
                  <span className="quiet-detail">{statusLabel(task.status)}</span>
                  <span className="quiet-detail">{repositoryNames(task)}</span>
                  <span className="quiet-end">
                    <time>{ago(task.updatedAt)}</time>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="overview-empty">Accepted work will appear here.</p>
          )}
        </section>
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
