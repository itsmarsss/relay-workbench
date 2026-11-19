import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { MarkdownEditor } from './MarkdownEditor';
import { useImageUpload } from './ImageUpload';
import { draftRequest } from './forms';
import { AgentSettings, agentOptions } from './AgentSettings';
import { jsonObject } from './forms';
import type { ImportedIssue, RelayConfig, Task } from './types';
const lastRepositoriesKey = 'relay-last-repositories';
// A new task starts with the repositories used last time, or the only one there is.
function initialRepositories(config: RelayConfig): string[] {
  const ids = config.repositories.map((repo) => repo.id);
  if (ids.length === 1) return ids;
  try {
    const last: unknown = JSON.parse(localStorage.getItem(lastRepositoriesKey) || '[]');
    if (Array.isArray(last)) return last.filter((id): id is string => ids.includes(id));
  } catch {}
  return [];
}
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
  onStart,
  onClose,
  onCreated,
}: {
  config: RelayConfig;
  workflowPreview: boolean;
  issueImportPreview: boolean;
  onImport: (repositoryId: string, ticket: string, signal?: AbortSignal) => Promise<ImportedIssue>;
  onCreate: (request: Record<string, unknown>) => Promise<Task>;
  // Starts the new task's investigation straight away; offered beside Create draft.
  onStart?: (task: Task) => Promise<unknown>;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [ticket, setTicket] = useState(''),
    [demo, setDemo] = useState(false),
    [selected, setSelected] = useState<string[]>(() => initialRepositories(config)),
    [primary, setPrimary] = useState(() => initialRepositories(config)[0] || ''),
    [preset, setPreset] = useState('bugfix'),
    [advanced, setAdvanced] = useState('{}'),
    [agents, setAgents] = useState(agentOptions),
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
        const start =
          (event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-start') === 'true';
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
              advanced: JSON.stringify({ ...jsonObject(advanced), ...agents }),
            },
            config,
          );
          setBusy(true);
          const task = await onCreate(request);
          try {
            if (!demo) localStorage.setItem(lastRepositoriesKey, JSON.stringify(selected));
          } catch {}
          if (start && onStart) await onStart(task).catch(() => {});
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
              ? 'You approve the approach before any code is written.'
              : 'Creates a draft. Agent execution is still being ported.'}
          </span>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className={onStart && workflowPreview ? undefined : 'primary'}
            disabled={busy || importing || uploads.busy}
          >
            {busy ? 'Creating…' : 'Create draft'}
          </button>
          {onStart && workflowPreview && (
            <button
              className="primary"
              type="submit"
              data-start="true"
              disabled={busy || importing || uploads.busy}
            >
              {busy ? 'Starting…' : 'Create and start'}
            </button>
          )}
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
      {!demo && (
        <fieldset>
          <legend>{config.repositories.length === 1 ? 'Repository' : 'Repositories'}</legend>
          {config.repositories.length > 5 && (
            <input
              aria-label="Filter repositories"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter repositories…"
            />
          )}
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
                    {selected.includes(repo.id) && selected.length > 1 && (
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
      <MarkdownEditor value={description} onChange={setDescription} uploads={uploads} />
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
        Demo · simulated agents, no repository commands
      </label>
      <details>
        <summary>Agents and execution</summary>
        <AgentSettings config={config} value={agents} onChange={setAgents} />
      </details>
      <details>
        <summary>Repository and dependency overrides</summary>
        <p className="form-note">JSON keys: dependencies, repositorySettings.</p>
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
