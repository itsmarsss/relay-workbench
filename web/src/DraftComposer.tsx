import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Markdown } from './Markdown';
import { useImageUpload } from './ImageUpload';
import { draftRequest } from './forms';
import type { ImportedIssue, RelayConfig, Task } from './types';
const presets = [
  { id: 'bugfix', label: 'Bug fix' },
  { id: 'small', label: 'Small change' },
  { id: 'investigate', label: 'Investigate only' },
  { id: 'cross-repo', label: 'Cross-repo feature' },
  { id: '', label: 'Custom' },
];
export function DraftComposer({
  config,
  workflowPreview,
  issueImportPreview,
  onImport,
  onCreate,
  onClose,
  onCreated,
}: {
  config: RelayConfig;
  workflowPreview: boolean;
  issueImportPreview: boolean;
  onImport: (repositoryId: string, ticket: string, signal?: AbortSignal) => Promise<ImportedIssue>;
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
    [importing, setImporting] = useState(false),
    [importWarnings, setImportWarnings] = useState<string[]>([]),
    [query, setQuery] = useState('');
  const importController = useRef<AbortController | null>(null);
  const uploads = useImageUpload((text) => setDescription((value) => value + text));
  const priorImport = useRef<{
    repositoryId: string;
    references: string[];
    description: string;
    title: string;
  } | null>(null);
  const current = useRef({ title, description, ticket, primary });
  current.current = { title, description, ticket, primary };
  useEffect(() => () => importController.current?.abort(), []);
  const primaryProfile = config.repositories.find((repository) => repository.id === primary);
  const hasImporter =
    !!primaryProfile?.issueCommand && typeof primaryProfile.issueCommand === 'object';
  async function importContext() {
    if (!primary || !ticket.trim() || importing || busy) return;
    const repositoryId = primary,
      reference = ticket.trim(),
      controller = new AbortController();
    importController.current = controller;
    setImporting(true);
    setError('');
    setImportWarnings([]);
    try {
      const result = await onImport(repositoryId, reference, controller.signal);
      if (current.current.primary !== repositoryId || current.current.ticket.trim() !== reference) {
        throw new Error('Repository or issue changed while importing. Try again.');
      }
      const previous = priorImport.current;
      const sameIssue =
        previous?.repositoryId === repositoryId && previous.references.includes(reference);
      const existing = current.current.description;
      const prefix =
        sameIssue && previous?.description && existing.endsWith(previous.description)
          ? existing.slice(0, -previous.description.length)
          : existing.trim() && result.description
            ? `${existing.trimEnd()}\n\n---\n\n`
            : existing;
      const nextDescription = prefix + result.description;
      if (nextDescription.length > 50000)
        throw new Error('Combined description exceeds 50,000 characters. Existing text was kept.');
      if (!current.current.title.trim() || (sameIssue && current.current.title === previous?.title))
        setTitle(result.title);
      setDescription(nextDescription);
      setTicket(result.ticket);
      priorImport.current = {
        repositoryId,
        references: [reference, result.ticket],
        description: result.description,
        title: result.title,
      };
      setImportWarnings(result.warnings);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError'))
        setError(failure instanceof Error ? failure.message : 'Could not import issue context.');
    } finally {
      if (importController.current === controller) importController.current = null;
      setImporting(false);
    }
  }
  function choose(id: string, checked: boolean) {
    const next = checked ? [...selected, id] : selected.filter((item) => item !== id);
    setSelected(next);
    if (!next.includes(primary)) setPrimary(next[0] || '');
  }
  return (
    <Modal
      title="New task"
      onClose={() => {
        if (!busy) {
          importController.current?.abort();
          onClose();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || importing || uploads.busy) return;
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
          <span className="form-note">
            {workflowPreview
              ? 'Creates a draft. Investigation and planning are available in preview.'
              : 'Creates a draft. Agent execution is still being ported.'}
          </span>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy || importing || uploads.busy}>
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
            onPaste={uploads.onPaste}
            onDrop={uploads.onDrop}
            onDragOver={uploads.onDragOver}
            rows={5}
            value={description}
            maxLength={50000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Requirements, context, and links. Markdown is supported."
          />
        )}
      </div>
      {uploads.control}
      <label className="field">
        Issue link or reference
        <input
          value={ticket}
          onChange={(event) => setTicket(event.target.value)}
          maxLength={2000}
        />
      </label>
      {issueImportPreview && !demo && (
        <div className="issue-import">
          <button
            type="button"
            disabled={!primary || !hasImporter || !ticket.trim() || importing || busy}
            onClick={() => void importContext()}
          >
            {importing ? 'Importing…' : 'Import issue context'}
          </button>
          <small>
            {!primary
              ? 'Select a repository first.'
              : !hasImporter
                ? 'Configure an issue import command for this repository.'
                : 'Imports the issue and available discussion into the description.'}
          </small>
          {importWarnings.map((warning) => (
            <p role="status" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      )}
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
