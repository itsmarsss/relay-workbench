import { Icon, ProviderIcon, RelayMark } from './UI';
import { inTaskScope } from './board';
import { ago, nextStep } from './presentation';
import { statusLabel, type Task } from './types';
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
  const waiting = tasks.filter((task) => inTaskScope(task, 'attention'));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  return (
    <section className="overview-page" aria-busy={loading}>
      <div className="page-title">
        <div>
          <div className="eyebrow">Your development, orchestrated</div>
          <h1>{greeting} Let’s make progress.</h1>
          <p>Your active work, decisions, and recent results.</p>
        </div>
        <button onClick={onCreate}>
          <Icon name="plus" size={16} />
          New task
        </button>
      </div>
      <div className="stats-grid">
        {(
          [
            ['active', 'In progress', 'active workflows', 'View active work', 'bolt'],
            [
              'attention',
              'Needs your input',
              'decisions & blockers',
              waiting.length ? 'Review decisions and blockers' : 'Nothing waiting on you',
              'inbox',
            ],
            ['done', 'Done', 'accepted results', 'View accepted work', 'check'],
          ] as const
        ).map(([scope, label, noun, foot, icon]) => (
          <button
            className={`stat-card ${scope === 'attention' ? 'attention' : ''}`}
            key={scope}
            onClick={() => onNavigate(`#tasks?scope=${scope}`)}
          >
            <span>{label}</span>
            <Icon name={icon} size={17} />
            <strong>
              {loading ? '—' : tasks.filter((t) => inTaskScope(t, scope)).length}
              <small>{noun}</small>
            </strong>
            <div className="stat-foot">{foot}</div>
          </button>
        ))}
      </div>
      {!!waiting.length && (
        <section className="overview-section">
          <h2>
            Needs your input <span className="count-chip">{waiting.length}</span>
          </h2>
          <div className="decision-grid">
            {waiting.slice(0, 4).map((task) => (
              <button
                className="decision-card"
                key={task.id}
                onClick={() => onNavigate(`#task/${task.id}/overview`)}
              >
                <span className="decision-icon">
                  <Icon name="inbox" />
                </span>
                <span>
                  <small>{statusLabel(task.status)}</small>
                  <strong>{task.title}</strong>
                  <span>{task.latestSummary || task.error || nextStep(task)}</span>
                </span>
                <Icon name="arrow" size={16} />
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="overview-section">
        <div className="section-heading">
          <h2>
            Recent work <span className="count-chip">{tasks.length}</span>
          </h2>
          <button className="text-button" onClick={() => onNavigate('#tasks')}>
            View all tasks
            <Icon name="arrow" size={16} />
          </button>
        </div>
        {tasks.length ? (
          <div className="recent-table">
            <div className="recent-table-header">
              <span>Task</span>
              <span>Status</span>
              <span>Specialists</span>
              <span>Updated</span>
            </div>
            {[...tasks]
              .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
              .slice(0, 8)
              .map((task) => (
                <button
                  className="recent-task"
                  key={task.id}
                  onClick={() => onNavigate(`#task/${task.id}/overview`)}
                >
                  <span className="recent-task-name">
                    <Icon name="tasks" size={20} />
                    <span>
                      <strong>{task.title}</strong>
                      <small>
                        {task.repository?.name || 'Unspecified'} · {nextStep(task)}
                      </small>
                    </span>
                  </span>
                  <span className={`task-status status-${task.status}`}>
                    {statusLabel(task.status)}
                  </span>
                  <span className="avatar-stack">
                    <ProviderIcon provider={task.currentRun?.harness || 'codex'} size={24} />
                  </span>
                  <time>{ago(task.updatedAt)}</time>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
          </div>
        ) : (
          <div className="welcome-card">
            <RelayMark size={56} />
            <h2>
              {loading ? 'Loading your workspace…' : 'Your next task has a whole team behind it.'}
            </h2>
            <p>
              Investigation, thoughtful design, implementation, and an independent review —
              connected by one clear thread.
            </p>
            <button className="primary" onClick={onCreate}>
              Create your first task
            </button>
            <small>You approve the approach. You have the final say.</small>
          </div>
        )}
      </section>
    </section>
  );
}
