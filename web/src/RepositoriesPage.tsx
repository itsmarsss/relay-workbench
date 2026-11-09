import type { RelayConfig, RepositoryProfile } from './types';
export function RepositoriesPage({
  config,
  onEdit,
  onAdd,
}: {
  config: RelayConfig;
  onEdit: (profile: RepositoryProfile) => void;
  onAdd: () => void;
}) {
  return (
    <section className="repositories-page">
      <div className="page-title">
        <div>
          <h1>Repositories</h1>
          <p>Local profiles for task workspaces and required checks.</p>
        </div>
        <button className="primary" onClick={onAdd}>
          Add repository
        </button>
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
    </section>
  );
}
