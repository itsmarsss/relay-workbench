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
// The end of a long path is what tells repositories apart; the full path is on hover.
function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : path;
}
type Added = { repository: RepositoryProfile; existing?: boolean; detected?: string[] };
export function RepositoriesPage({
  config,
  onEdit,
  onAdd,
  onChanged,
}: {
  config: RelayConfig;
  onEdit: (profile: RepositoryProfile) => void;
  onAdd: (profile?: RepositoryProfile) => void;
  onChanged: () => void;
}) {
  const [root, setRoot] = useState(''),
    [report, setReport] = useState<DiscoveryReport | null>(null),
    [url, setUrl] = useState(''),
    [folder, setFolder] = useState(''),
    [added, setAdded] = useState<Added | null>(null),
    [adding, setAdding] = useState('');
  const panel = useRef<HTMLElement>(null),
    search = useRef<HTMLInputElement>(null),
    cloneInput = useRef<HTMLInputElement>(null),
    mutation = useMutation(),
    quick = useMutation();
  // One click: Relay saves a profile from what it detects; editing it is optional.
  async function addNow(path: string) {
    setAdding(path);
    try {
      setAdded(await quick.run<Added>('/api/repositories/add', { path }));
      onChanged();
    } catch {
    } finally {
      setAdding('');
    }
  }
  async function clone() {
    try {
      setAdded(
        await quick.run<Added>('/api/repositories/clone', {
          url: url.trim(),
          ...(folder.trim() ? { directory: folder.trim() } : {}),
        }),
      );
      setUrl('');
      onChanged();
    } catch {}
  }
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
      <section className="surface repository-clone" aria-label="Add a repository">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void clone();
          }}
        >
          <div className="field">
            <label htmlFor="repository-clone-url">Clone from a URL</label>
            <div className="repository-scan-row">
              <input
                id="repository-clone-url"
                ref={cloneInput}
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="primary" disabled={quick.busy || !url.trim()}>
                {quick.busy && !adding ? 'Cloning…' : 'Clone and add'}
              </button>
            </div>
          </div>
          <details className="discovery-scope">
            <summary>Clone into another folder</summary>
            <input
              aria-label="Folder to clone into"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder="Absolute folder; ~/relay-repositories by default"
            />
          </details>
        </form>
        {quick.error && <Notice>{quick.error}</Notice>}
        {added && (
          <p role="status" className="repository-added">
            <strong>{added.repository.name}</strong>{' '}
            {added.existing ? 'was already added.' : 'is ready.'}{' '}
            {added.detected?.length
              ? `Install step: ${added.detected.join(', ')}.`
              : 'No install step was needed.'}{' '}
            An agent works out its checks from the repository’s own guidance.{' '}
            <button type="button" className="text-button" onClick={() => onEdit(added.repository)}>
              Edit settings
            </button>
          </p>
        )}
        <p className="form-note">
          Uses your own Git login.{' '}
          <button type="button" className="text-button" onClick={() => onAdd()}>
            Set up a folder by hand
          </button>
        </p>
      </section>
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
              <code title={repo.path}>{shortPath(repo.path)}</code>
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
          <p>
            Paste a repository URL below, or find a checkout already on this machine. Relay works
            out its name, install step and checks.
          </p>
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
                          <button disabled={quick.busy} onClick={() => void addNow(repo.path)}>
                            {adding === repo.path ? 'Adding…' : 'Add'}
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
