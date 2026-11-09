import { useState } from 'react';
import { Modal } from './Modal';
import { Markdown } from './Markdown';
import { draftRequest } from './forms';
import type { RelayConfig, Task } from './types';
const presets = [
  { id: 'bugfix', label: 'Bug fix' },
  { id: 'small', label: 'Small change' },
  { id: 'investigate', label: 'Investigate only' },
  { id: 'cross-repo', label: 'Cross-repo feature' },
  { id: '', label: 'Custom' },
];
export function DraftComposer({
  config,
  onCreate,
  onClose,
  onCreated,
}: {
  config: RelayConfig;
  onCreate: (request: Record<string, unknown>) => Promise<Task>;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [ticket, setTicket] = useState(''),
    [demo, setDemo] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [primary, setPrimary] = useState(''),
    [preset, setPreset] = useState('bugfix'),
    [advanced, setAdvanced] = useState('{}'),
    [preview, setPreview] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('');
  function choose(id: string, checked: boolean) {
    const next = checked ? [...selected, id] : selected.filter((item) => item !== id);
    setSelected(next);
    if (!next.includes(primary)) setPrimary(next[0] || '');
  }
  return (
    <Modal
      title="New task"
      onClose={() => {
        if (!busy) onClose();
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setError('');
        try {
          const request = draftRequest(
            {
              title,
              description,
              ticket,
              demo,
              repositories: selected,
              primary,
              preset: preset || null,
              advanced,
            },
            config,
          );
          setBusy(true);
          const task = await onCreate(request);
          onCreated(task);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : 'Could not create task.');
        } finally {
          setBusy(false);
        }
      }}
      footer={
        <>
          <span className="form-note">Creates a draft. Agent execution is still being ported.</span>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create draft'}
          </button>
        </>
      }
    >
      {error && (
        <p className="error" role="status">
          {error}
        </p>
      )}
      <label className="field">
        Title
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={240}
          required
          autoFocus
        />
      </label>
      <div className="field">
        <div className="field-heading">
          <label htmlFor="draft-description">Description</label>
          <div role="group" aria-label="Description editor">
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
        </div>
        {preview ? (
          <div className="markdown-preview">
            <Markdown text={description || 'Nothing to preview yet.'} />
          </div>
        ) : (
          <textarea
            id="draft-description"
            rows={5}
            value={description}
            maxLength={50000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Requirements, context, and links. Markdown is supported."
          />
        )}
      </div>
      <label className="field">
        Issue link or reference
        <input
          value={ticket}
          onChange={(event) => setTicket(event.target.value)}
          maxLength={2000}
        />
      </label>
      <fieldset>
        <legend>Workflow</legend>
        <div className="choice-row">
          {presets.map((item) => (
            <label key={item.id} className={preset === item.id ? 'choice selected' : 'choice'}>
              <input
                type="radio"
                name="preset"
                checked={preset === item.id}
                onChange={() => setPreset(item.id)}
              />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="check-row">
        <input type="checkbox" checked={demo} onChange={(event) => setDemo(event.target.checked)} />
        Demo draft
      </label>
      {!demo && (
        <fieldset>
          <legend>Repositories</legend>
          <input
            aria-label="Filter repositories"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter repositories…"
          />
          {config.repositories.length === 0 ? (
            <p className="form-note">Add a repository profile first, or create a demo draft.</p>
          ) : (
            <div className="repository-choices">
              {config.repositories
                .filter((repo) =>
                  `${repo.name} ${repo.path}`.toLowerCase().includes(query.toLowerCase()),
                )
                .map((repo) => (
                  <div key={repo.id} className="repository-choice">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={selected.includes(repo.id)}
                        onChange={(event) => choose(repo.id, event.target.checked)}
                      />
                      <span>
                        <strong>{repo.name}</strong>
                        <small>{repo.path}</small>
                      </span>
                    </label>
                    {selected.includes(repo.id) && (
                      <label className="check-row">
                        <input
                          type="radio"
                          name="primary"
                          checked={primary === repo.id}
                          onChange={() => setPrimary(repo.id)}
                        />
                        Primary
                      </label>
                    )}
                  </div>
                ))}
            </div>
          )}
        </fieldset>
      )}
      <details>
        <summary>Agent, execution, and repository options</summary>
        <p className="form-note">
          JSON keys: routing, models, execution, dependencies, repositorySettings, smartRouting.
        </p>
        <textarea
          aria-label="Advanced task options"
          className="code-input"
          rows={7}
          value={advanced}
          onChange={(event) => setAdvanced(event.target.value)}
        />
      </details>
    </Modal>
  );
}
