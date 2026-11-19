import { useResource, useSession } from './Session';
import { Icon, ProviderIcon, providerName } from './UI';
import { asObject } from './task-data';
import type { Task } from './types';

type Catalog = Record<string, { models?: unknown[]; error?: string; status?: string }>;

// First run: which agent CLIs Relay found, a repository, a first task. It goes away once there is
// a repository and a real task.
export function GettingStarted({
  tasks,
  onNavigate,
  onCreate,
}: {
  tasks: Task[];
  onNavigate: (hash: string) => void;
  onCreate: () => void;
}) {
  const { bootstrap } = useSession(),
    models = useResource<Catalog>('/api/models');
  const repositories = bootstrap?.config.repositories || [],
    realTask = tasks.some((task) => (task as { demo?: boolean }).demo !== true);
  if (!bootstrap || (repositories.length > 0 && realTask)) return null;
  const harnesses = asObject(bootstrap.config.harnesses) || {};
  const agents = ['claude', 'codex', 'pi'].filter(
    (id) => asObject(harnesses[id])?.enabled === true,
  );
  const found = agents.filter((id) => models.data?.[id]?.status === 'ready');
  const steps = [
    {
      done: found.length > 0,
      title: 'Agents',
      body: models.loading
        ? 'Looking for agent CLIs…'
        : found.length
          ? `Found ${found.map(providerName).join(', ')}. Relay uses their existing logins.`
          : 'No agent CLI answered. Install Claude Code, Codex or Pi and log in, then reload.',
      icons: found,
      action: !found.length && { label: 'Agent settings', go: () => onNavigate('#agents') },
    },
    {
      done: repositories.length > 0,
      title: 'Add a repository',
      body: repositories.length
        ? `${repositories.length === 1 ? repositories[0]!.name : `${repositories.length} repositories`} ready.`
        : 'Find a checkout on this machine or paste a GitHub URL. Relay detects the rest.',
      action: !repositories.length && {
        label: 'Add a repository',
        go: () => onNavigate('#repositories'),
      },
    },
    {
      done: realTask,
      title: 'Start a task',
      body: repositories.length
        ? 'Describe the change or paste an issue link. You approve the approach before any code is written.'
        : 'Or try a demo first: simulated agents, no repository needed.',
      action: { label: repositories.length ? 'New task' : 'Try a demo', go: onCreate },
    },
  ];
  return (
    <section className="surface getting-started" aria-label="Getting started">
      <div className="section-heading">
        <div>
          <h2>Get set up</h2>
          <p>Three steps, then Relay is ready for real work.</p>
        </div>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title} data-done={step.done}>
            <span className="getting-started-mark" aria-hidden="true">
              {step.done ? '✓' : index + 1}
            </span>
            <div>
              <strong>
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
              </strong>
              <p>{step.body}</p>
              {'icons' in step && step.icons && step.icons.length > 0 && (
                <span className="inline">
                  {step.icons.map((id) => (
                    <ProviderIcon key={id} provider={id} size={18} />
                  ))}
                </span>
              )}
            </div>
            {step.action && !step.done && (
              <button type="button" onClick={step.action.go}>
                {step.action.label}
                <Icon name="chevron" size={14} />
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
