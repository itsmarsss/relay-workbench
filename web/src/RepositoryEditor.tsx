import { useState } from 'react';
import { Select } from './UI';
import { Notice, useMutation } from './Session';
import { Modal } from './Modal';
import { jsonArray, jsonObject } from './forms';
import type { RelayConfig, RepositoryProfile } from './types';
export function RepositoryEditor({
  config,
  revision,
  profile,
  onSave,
  onClose,
}: {
  config: RelayConfig;
  revision: string;
  profile?: RepositoryProfile;
  onSave: (revision: string, config: RelayConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [id] = useState(() => profile?.id || crypto.randomUUID()),
    [name, setName] = useState(profile?.name || ''),
    [path, setPath] = useState(profile?.path || ''),
    [cwd, setCwd] = useState(profile?.cwd || '.'),
    [strategy, setStrategy] = useState(profile?.strategy || 'worktree'),
    [mode, setMode] = useState(profile?.verificationMode || 'agent'),
    [instructions, setInstructions] = useState(profile?.instructions || ''),
    [checks, setChecks] = useState(JSON.stringify(profile?.checks || [], null, 2)),
    [setup, setSetup] = useState(JSON.stringify(profile?.setup || [], null, 2)),
    [advanced, setAdvanced] = useState(
      JSON.stringify(
        {
          workspaceCommand: profile?.workspaceCommand || null,
          workspacePath: profile?.workspacePath || '',
          issueCommand: profile?.issueCommand || null,
          prCommand: profile?.prCommand || null,
          developmentAccess: profile?.developmentAccess || {},
        },
        null,
        2,
      ),
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const exists = config.repositories.some((repo) => repo.id === id);
  const discovery = useMutation();
  const [suggestions, setSuggestions] = useState<
    { field: string; label: string; value: unknown; evidence: string }[]
  >([]);
  return (
    <Modal
      title={exists ? 'Edit repository' : 'Add repository'}
      onClose={() => {
        if (!busy) onClose();
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setError('');
        try {
          const options = jsonObject(advanced);
          const allowed = new Set([
            'workspaceCommand',
            'workspacePath',
            'issueCommand',
            'prCommand',
            'developmentAccess',
          ]);
          if (Object.keys(options).some((key) => !allowed.has(key)))
            throw new Error('Advanced profile options include an unsupported key.');
          const next = {
            ...profile,
            ...options,
            id,
            name,
            path,
            cwd,
            strategy,
            verificationMode: mode,
            instructions,
            checks: jsonArray(checks),
            setup: jsonArray(setup),
          } as RepositoryProfile;
          const updated = structuredClone(config);
          updated.repositories = exists
            ? updated.repositories.map((repo) => (repo.id === id ? next : repo))
            : [...updated.repositories, next];
          setBusy(true);
          await onSave(revision, updated);
          onClose();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : 'Could not save repository.');
        } finally {
          setBusy(false);
        }
      }}
      footer={
        <>
          <span className="form-note">
            Commands are stored as argument arrays. Saving does not run them.
          </span>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save repository'}
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
        Name
        <input
          autoFocus
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        Repository path
        <input
          required
          maxLength={2000}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="Absolute path to the checkout"
        />
      </label>
      <div className="profile-suggestions">
        <button
          type="button"
          disabled={discovery.busy || !path}
          onClick={() =>
            void discovery
              .run<{ suggestions: typeof suggestions }>('/api/repositories/suggestions', {
                path,
                cwd,
              })
              .then((value) => setSuggestions(value.suggestions))
              .catch(() => {})
          }
        >
          {discovery.busy ? 'Inspecting…' : 'Suggest profile fields'}
        </button>
        {discovery.error && <Notice>{discovery.error}</Notice>}
        {suggestions.length > 0 && (
          <div className="suggestion-list">
            {suggestions.map((item, i) => (
              <button
                type="button"
                key={i}
                onClick={() => {
                  if (item.field === 'name') setName(String(item.value));
                  if (item.field === 'cwd') setCwd(String(item.value));
                  if (item.field === 'path') setPath(String(item.value));
                  if (item.field === 'checks') {
                    try {
                      const current = jsonArray(checks);
                      if (
                        !current.some((row) => JSON.stringify(row) === JSON.stringify(item.value))
                      )
                        setChecks(JSON.stringify([...current, item.value], null, 2));
                    } catch {
                      setError('Fix the checks JSON before adding suggestions.');
                    }
                  }
                }}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.evidence}</small>
                </span>
                <span>Use</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <label className="field">
        Working subdirectory
        <input
          required
          maxLength={2000}
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Workspace strategy</legend>
        <div className="choice-row">
          {(['worktree', 'managed', 'attach'] as const).map((value) => (
            <label key={value} className={`choice ${strategy === value ? 'selected' : ''}`}>
              <input
                type="radio"
                name="strategy"
                checked={strategy === value}
                onChange={() => setStrategy(value)}
              />
              {
                {
                  worktree: 'New worktree',
                  managed: 'Repository-managed',
                  attach: 'Attach to checkout',
                }[value]
              }
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Verification</legend>
        <div className="choice-row">
          {(['agent', 'commands'] as const).map((value) => (
            <label key={value} className={`choice ${mode === value ? 'selected' : ''}`}>
              <input
                type="radio"
                name="verification"
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {value === 'agent' ? 'Agent discovers checks' : 'Required commands'}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        Required checks (JSON)
        <textarea
          rows={4}
          className="code-input"
          value={checks}
          onChange={(event) => setChecks(event.target.value)}
          placeholder={'[{"command":"test","args":["unit"]}]'}
        />
      </label>
      <label className="field">
        Setup commands (JSON)
        <textarea
          rows={4}
          className="code-input"
          value={setup}
          onChange={(event) => setSetup(event.target.value)}
        />
      </label>
      <label className="field">
        Repository instructions
        <textarea
          rows={5}
          maxLength={50000}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <details>
        <summary>Managed workspace and provider commands</summary>
        <p className="form-note">
          Configure workspaceCommand and workspacePath for managed workspaces. An issueCommand must
          include <code>{'{ticket}'}</code> as a separate argument.
        </p>
        <textarea
          aria-label="Advanced repository options"
          rows={8}
          className="code-input"
          value={advanced}
          onChange={(event) => setAdvanced(event.target.value)}
        />
      </details>
    </Modal>
  );
}
