import { useState } from 'react';
import { Modal } from './Modal';
import { Notice, useMutation } from './Session';
import type { RelayConfig, RepositoryProfile } from './types';
export function RepositoriesPage({
  config,
  onEdit,
  onAdd,
}: {
  config: RelayConfig;
  onEdit: (profile: RepositoryProfile) => void;
  onAdd: (profile?: RepositoryProfile) => void;
}) {
  const [discovering, setDiscovering] = useState(false),
    [root, setRoot] = useState(''),
    [found, setFound] = useState<{ path: string; name: string }[]>([]);
  const mutation = useMutation();
  return (
    <section className="repositories-page">
      <div className="page-title">
        <div>
          <h1>Repositories</h1>
          <p>Local profiles for task workspaces and required checks.</p>
        </div>
        <div className="inline">
          <button onClick={() => setDiscovering(true)}>Find repositories</button>
          <button className="primary" onClick={() => onAdd()}>
            Add repository
          </button>
        </div>
      </div>
      {config.repositories.length ? (
        <div className="repository-grid">
          {config.repositories.map((repo) => (
            <article className="repository-card" key={repo.id}>
              <header>
                <h2>{repo.name}</h2>
                <button onClick={() => onEdit(repo)}>Edit</button>
              </header>
              <code>{repo.path}</code>
              <dl>
                <div>
                  <dt>Working directory</dt>
                  <dd>{repo.cwd}</dd>
                </div>
                <div>
                  <dt>Workspace</dt>
                  <dd>
                    {
                      {
                        worktree: 'New worktree',
                        managed: 'Repository-managed',
                        attach: 'Attached checkout',
                      }[repo.strategy]
                    }
                  </dd>
                </div>
                <div>
                  <dt>Verification</dt>
                  <dd>
                    {repo.verificationMode === 'agent'
                      ? 'Agent-discovered checks'
                      : `${repo.checks.length} required commands`}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <h2>No repository profiles</h2>
          <p>Add a checkout path to create real task drafts.</p>
        </div>
      )}
      {discovering && (
        <Modal
          title="Find repositories"
          onClose={() => setDiscovering(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation
              .run<{ path: string; name: string }[]>(
                '/api/repositories/discover',
                root.trim() ? { roots: [root.trim()] } : {},
              )
              .then(setFound)
              .catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setDiscovering(false)}>
                Close
              </button>
              <button className="primary" disabled={mutation.busy}>
                {mutation.busy ? 'Searching…' : 'Scan folders'}
              </button>
            </>
          }
        >
          <label className="field">
            Search folder
            <input
              placeholder="Default development folders"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
            />
          </label>
          <p className="muted">
            Scans up to four folders deep. Dependency folders and links are skipped.
          </p>
          {mutation.error && <Notice>{mutation.error}</Notice>}
          <div className="record-list">
            {found.map((repo) => (
              <button
                type="button"
                className="repository-discovery-row"
                key={repo.path}
                disabled={config.repositories.some((r) => r.path === repo.path)}
                onClick={() => {
                  setDiscovering(false);
                  onAdd({
                    id: crypto.randomUUID(),
                    name: repo.name,
                    path: repo.path,
                    cwd: '.',
                    strategy: 'worktree',
                    verificationMode: 'agent',
                    instructions: '',
                    checks: [],
                    setup: [],
                  });
                }}
              >
                <span>
                  <strong>{repo.name}</strong>
                  <small>{repo.path}</small>
                </span>
                <span>
                  {config.repositories.some((r) => r.path === repo.path) ? 'Added' : 'Add'}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
