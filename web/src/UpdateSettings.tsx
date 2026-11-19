import { Notice, useMutation, useResource } from './Session';
import { ago } from './presentation';

type UpdateStatus = {
  enabled: boolean;
  available: boolean;
  state: string;
  summary: string;
  current?: string;
  latest?: string;
  checkedAt?: string;
};

// Keeping a Relay that runs from its own repository up to date with commits that passed CI.
export function UpdateSettings() {
  const status = useResource<UpdateStatus>('/api/updates'),
    mutation = useMutation();
  const value = status.data;
  async function send(body: Record<string, unknown>) {
    await mutation.run('/api/updates', body);
    await status.refresh();
  }
  return (
    <section className="surface update-settings">
      <div className="section-heading">
        <div>
          <h2>Updates</h2>
          <p>
            {value?.available === false
              ? 'Automatic updates work when Relay runs from a clone of its repository.'
              : 'Pulls new commits on main once their CI passes, then restarts when nothing is running.'}
          </p>
        </div>
        {value?.available && (
          <div className="inline">
            <button
              type="button"
              disabled={mutation.busy || !value.enabled}
              onClick={() => void send({ check: true }).catch(() => {})}
            >
              Check now
            </button>
            <button
              type="button"
              aria-pressed={value.enabled}
              disabled={mutation.busy}
              onClick={() => void send({ enabled: !value.enabled }).catch(() => {})}
            >
              {value.enabled ? 'Turn off updates' : 'Turn on updates'}
            </button>
          </div>
        )}
      </div>
      {value?.available && (
        <p role="status" className="update-status" data-state={value.state}>
          {value.enabled
            ? value.summary || 'Waiting for the first check.'
            : 'Automatic updates are off.'}
          {value.current && <span className="muted"> · running {value.current}</span>}
          {value.checkedAt && (
            <span className="muted"> · checked {ago(value.checkedAt).toLowerCase()}</span>
          )}
        </p>
      )}
      {(status.error || mutation.error) && <Notice>{status.error || mutation.error}</Notice>}
    </section>
  );
}
