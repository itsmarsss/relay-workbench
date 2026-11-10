import { useRef, useState } from 'react';
import { Icon } from './UI';
import { Notice, useMutation } from './Session';
import type { RelayConfig, RepositoryProfile } from './types';
type Discovered = { path: string; name: string; configuredId?: string };
type DiscoveryReport = {
  repositories: Discovered[];
  roots: string[];
  warnings: string[];
  truncated: boolean;
};
export function RepositoriesPage({
  config,
  onEdit,
  onAdd,
}: {
  config: RelayConfig;
  onEdit: (profile: RepositoryProfile) => void;
  onAdd: (profile?: RepositoryProfile) => void;
}) {
  const [root, setRoot] = useState(''),
    [report, setReport] = useState<DiscoveryReport | null>(null);
  const panel = useRef<HTMLElement>(null),
    search = useRef<HTMLInputElement>(null),
    mutation = useMutation();
  function scan(common = false) {
    void mutation
      .run<DiscoveryReport>('/api/repositories/discover', {
        details: true,
        ...(!common && root.trim() ? { roots: [root.trim()] } : {}),
      })
      .then(setReport)
      .catch(() => {});
  }
  return (
    <section className="repositories-page">
      <div className="page-title">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Repositories</h1>
          <p>Repository profiles and task workspaces.</p>
        </div>
        <div className="inline">
          <button
            onClick={() => {
              panel.current?.scrollIntoView({
                block: 'nearest',
                behavior:
                  document.documentElement.dataset.lowMotion === 'true' ? 'instant' : 'smooth',
              });
              search.current?.focus({ preventScroll: true });
            }}
          >
            Find repositories
          </button>
          <button className="primary" onClick={() => onAdd()}>
            <Icon name="plus" size={16} />
            Add repository
          </button>
        </div>
      </div>
      <div className="repository-section-heading">
        <h2>Connected repositories</h2>
        <span>
          {config.repositories.length} {config.repositories.length === 1 ? 'profile' : 'profiles'}
        </span>
      </div>
      {config.repositories.length ? (
        <div className="repository-grid">
          {config.repositories.map((repo) => (
            <article className="repository-card" key={repo.id}>
              <header>
                <span className="repo-icon">
                  <Icon name="repository" size={22} />
                </span>
                <h2>{repo.name}</h2>
                <button className="text-button" onClick={() => onEdit(repo)}>
                  Edit profile
                </button>
              </header>
              <code>{repo.path}</code>
              <dl>
                <div>
                  <dt>Workspace</dt>
                  <dd>
                    {
                      {
                        worktree: 'New worktree per task',
                        managed: 'Managed task worktree',
                        attach: 'Attached checkout',
                      }[repo.strategy]
                    }
                  </dd>
                </div>
                <div>
                  <dt>Verification</dt>
                  <dd>
                    {repo.verificationMode === 'agent'
                      ? 'Agent discovers checks'
                      : `${repo.checks.length} configured commands`}
                  </dd>
                </div>
                <div>
                  <dt>Working directory</dt>
                  <dd>{repo.cwd}</dd>
                </div>
                {repo.setup.length > 0 && (
                  <div>
                    <dt>Setup</dt>
                    <dd>
                      {repo.setup.length} {repo.setup.length === 1 ? 'command' : 'commands'}
                    </dd>
                  </div>
                )}
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <h2>Connect your first repository</h2>
          <p>Choose a local checkout to start real work.</p>
          <button onClick={() => onAdd()}>Add a checkout</button>
        </div>
      )}
      <section ref={panel} className="repository-discovery" aria-label="Repository discovery">
        <div className="section-heading">
          <div>
            <h2>Find repositories</h2>
            <p>Detect local Git checkouts, then choose which to add.</p>
          </div>
          <button disabled={mutation.busy} onClick={() => scan(true)}>
            {mutation.busy ? 'Scanning…' : 'Scan common folders'}
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            scan();
          }}
        >
          <div className="field">
            <label htmlFor="repository-search-folder">Search folder</label>
            <div className="repository-scan-row">
              <input
                id="repository-search-folder"
                ref={search}
                required
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                placeholder="Absolute folder path"
              />
              <button disabled={mutation.busy}>Scan folder</button>
            </div>
          </div>
        </form>
        {mutation.error && <Notice>{mutation.error}</Notice>}
        <div aria-live="polite">
          {mutation.busy ? (
            <p role="status" className="form-note">
              Looking for Git checkouts…
            </p>
          ) : report ? (
            <>
              {report.repositories.length ? (
                <ul className="discovered-repositories">
                  {report.repositories.map((repo) => {
                    const configured = config.repositories.some(
                      (item) => item.path === repo.path || item.id === repo.configuredId,
                    );
                    return (
                      <li key={repo.path}>
                        <Icon name="repository" size={18} />
                        <div>
                          <strong>{repo.name}</strong>
                          <code>{repo.path}</code>
                        </div>
                        {configured ? (
                          <span className="discovery-added">Added</span>
                        ) : (
                          <button
                            onClick={() =>
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
                              })
                            }
                          >
                            Add
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>No Git checkouts found. Try a specific parent folder.</p>
              )}
              {report.truncated && (
                <p className="form-note">Scan limit reached. Try a narrower folder.</p>
              )}
              {report.warnings.map((warning, index) => (
                <p className="form-note" key={index}>
                  {warning}
                </p>
              ))}
              <details className="discovery-scope">
                <summary>Scanned folders ({report.roots.length})</summary>
                <ul>
                  {report.roots.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <p className="form-note">
              Scans four folders deep. Build caches, dependencies and links are skipped.
            </p>
          )}
        </div>
      </section>
    </section>
  );
}
