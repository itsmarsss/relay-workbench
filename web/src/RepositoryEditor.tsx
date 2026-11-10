import { Markdown } from './Markdown';
import { CommandEditor, CommandListEditor, type Command } from './CommandEditor';
import { asObject } from './task-data';
import { motion } from 'motion/react';
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
  const [tab, setTab] = useState('general'),
    [preview, setPreview] = useState(false);
  const tabs = [
    ['general', 'General'],
    ['workspace', 'Workspace'],
    ['checks', 'Checks & setup'],
    ['integrations', 'Integrations'],
    ['guidance', 'Guidance'],
  ];
  let options: Record<string, unknown> = {};
  try {
    options = jsonObject(advanced);
  } catch {}
  function setOption(key: string, value: unknown) {
    try {
      setAdvanced(JSON.stringify({ ...jsonObject(advanced), [key]: value }, null, 2));
      setError('');
    } catch {
      setError('Fix the advanced JSON before editing integration fields.');
    }
  }
  function commandField(key: string, label: string) {
    const raw = asObject(options[key]);
    const value: Command = {
      command: typeof raw?.command === 'string' ? raw.command : '',
      args: Array.isArray(raw?.args) ? raw.args.map(String) : [],
    };
    return (
      <section className="integration-command">
        <div className="section-heading">
          <h3>{label}</h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!raw}
              onChange={(event) =>
                setOption(key, event.target.checked ? { command: '', args: [] } : null)
              }
            />
            Enabled
          </label>
        </div>
        {raw && (
          <CommandEditor label={label} value={value} onChange={(value) => setOption(key, value)} />
        )}
      </section>
    );
  }
  function commandList(value: string, label: string, change: (value: string) => void) {
    try {
      return (
        <CommandListEditor
          label={label}
          value={jsonArray(value)}
          onChange={(next) => change(JSON.stringify(next, null, 2))}
        />
      );
    } catch {
      return (
        <label className="field">
          {label} (repair invalid JSON)
          <textarea rows={4} value={value} onChange={(event) => change(event.target.value)} />
        </label>
      );
    }
  }

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
      <div className="profile-tabs" role="tablist" aria-label="Repository profile sections">
        {tabs.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            id={`profile-tab-${id}`}
            aria-controls={`profile-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            key={id}
            onClick={() => setTab(id!)}
            onKeyDown={(event) => {
              let index = tabs.findIndex(([value]) => value === tab);
              if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
              else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
              else if (event.key === 'Home') index = 0;
              else if (event.key === 'End') index = tabs.length - 1;
              else return;
              event.preventDefault();
              setTab(tabs[index]![0]!);
              document.getElementById(`profile-tab-${tabs[index]![0]}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <motion.div
        key={tab}
        role="tabpanel"
        id={`profile-panel-${tab}`}
        aria-labelledby={`profile-tab-${tab}`}
        initial={{ opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
      >
        {tab === 'general' && (
          <>
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
                        if (item.field === 'checks' || item.field === 'setup') {
                          try {
                            const current = jsonArray(item.field === 'checks' ? checks : setup);
                            if (
                              !current.some(
                                (row) => JSON.stringify(row) === JSON.stringify(item.value),
                              )
                            )
                              (item.field === 'checks' ? setChecks : setSetup)(
                                JSON.stringify([...current, item.value], null, 2),
                              );
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
          </>
        )}
        {tab === 'workspace' && (
          <>
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
            {strategy === 'managed' && (
              <>
                <label className="field">
                  Workspace path template
                  <input
                    value={String(options.workspacePath || '')}
                    maxLength={2000}
                    onChange={(event) => setOption('workspacePath', event.target.value)}
                    placeholder="Absolute path with {taskId}"
                  />
                </label>
                {commandField('workspaceCommand', 'Workspace creation command')}
                <p className="form-note">
                  Use {'{taskId}'}, {'{workspaceName}'}, {'{branch}'} and {'{baseCommit}'}{' '}
                  placeholders. The manager must create a separate clean Git worktree.
                </p>
              </>
            )}
            {strategy === 'attach' && (
              <p className="form-note">
                Uses this checkout directly. It must be clean when first attached. Local changes are
                preserved and block attachment.
              </p>
            )}
          </>
        )}
        {tab === 'checks' && (
          <>
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
            {commandList(checks, 'Required checks', setChecks)}
            {commandList(setup, 'Setup commands', setSetup)}
          </>
        )}
        {tab === 'guidance' && (
          <>
            <div className="section-heading">
              <h3>Repository instructions</h3>
              <div className="segmented">
                <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                  Write
                </button>
                <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                  Preview
                </button>
              </div>
            </div>
            {preview ? (
              <Markdown text={instructions || 'Nothing to preview yet.'} />
            ) : (
              <label className="field">
                <textarea
                  aria-label="Repository instructions"
                  rows={5}
                  maxLength={50000}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
            )}
          </>
        )}
        {tab === 'integrations' && (
          <>
            {commandField('issueCommand', 'Issue import command')}
            <p className="form-note">
              Include {'{ticket}'} as a separate argument. The provider must return the complete
              issue description and discussion.
            </p>
            {commandField('prCommand', 'Pull request command')}
            <details>
              <summary>Advanced integration and access options</summary>
              <p className="form-note">
                Configure workspaceCommand and workspacePath for managed workspaces. An issueCommand
                must include <code>{'{ticket}'}</code> as a separate argument.
              </p>
              <textarea
                aria-label="Advanced repository options"
                rows={8}
                className="code-input"
                value={advanced}
                onChange={(event) => setAdvanced(event.target.value)}
              />
            </details>
          </>
        )}
      </motion.div>
    </Modal>
  );
}
