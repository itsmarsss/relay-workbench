import { MarkdownEditor } from './MarkdownEditor';
import { useImageUpload } from './ImageUpload';
import { useRepositoryDetection, type ProfileSuggestion } from './useRepositoryDetection';
import { CommandEditor, CommandListEditor, type Command } from './CommandEditor';
import { asObject } from './task-data';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Select } from './UI';
import { Notice } from './Session';
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
  useEffect(() => setError(''), [name, path, cwd, strategy, mode, instructions, checks, setup]);
  const [tab, setTab] = useState('general'),
    [removing, setRemoving] = useState(false);
  const keepProfile = useRef<HTMLButtonElement>(null),
    removeButton = useRef<HTMLButtonElement>(null),
    removalWasOpen = useRef(false);
  useEffect(() => {
    if (removing) keepProfile.current?.focus();
    else if (removalWasOpen.current) removeButton.current?.focus();
    removalWasOpen.current = removing;
  }, [removing]);
  const uploads = useImageUpload((text) => setInstructions((value) => value + text));
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

  const detection = useRepositoryDetection(path, cwd);
  useEffect(() => {
    const suggested = detection.result?.suggestions.filter((item) => item.field === 'name').at(-1);
    if (suggested && typeof suggested.value === 'string')
      setName((current) => (current.trim() ? current : String(suggested.value)));
  }, [detection.result]);
  function applySuggestion(item: ProfileSuggestion) {
    if (item.field === 'name') setName(String(item.value));
    else if (item.field === 'path' || item.field === 'cwd') {
      if (!detection.result) return;
      setPath(detection.result.root);
      setCwd((item.field === 'cwd' ? String(item.value) : detection.result.cwd) || '.');
    } else {
      try {
        const current = jsonArray(item.field === 'checks' ? checks : setup);
        if (!current.some((row) => JSON.stringify(row) === JSON.stringify(item.value)))
          (item.field === 'checks' ? setChecks : setSetup)(
            JSON.stringify([...current, item.value], null, 2),
          );
        if (item.field === 'checks') setMode('commands');
        setTab('checks');
      } catch {
        setError('Fix the existing command JSON before adding a suggestion.');
      }
    }
  }
  async function removeProfile() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave(revision, {
        ...config,
        repositories: config.repositories.filter((repo) => repo.id !== id),
      });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not remove repository.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={exists ? 'Edit repository' : 'Add repository'}
      onClose={() => {
        if (!busy) onClose();
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || removing) return;
        setError('');
        try {
          if (!name.trim() || !path.trim() || !cwd.trim()) {
            setTab('general');
            throw new Error('Enter a name, repository path and working directory.');
          }
          let options: Record<string, unknown>;
          try {
            options = jsonObject(advanced);
          } catch {
            setTab('integrations');
            throw new Error('Fix the advanced profile JSON before saving.');
          }
          if (
            strategy === 'managed' &&
            (!String(options.workspacePath || '').trim() ||
              !asObject(options.workspaceCommand)?.command)
          ) {
            setTab('workspace');
            throw new Error('Managed workspaces need a path template and creation command.');
          }
          const allowed = new Set([
            'workspaceCommand',
            'workspacePath',
            'issueCommand',
            'prCommand',
            'developmentAccess',
          ]);
          if (Object.keys(options).some((key) => !allowed.has(key))) {
            setTab('integrations');
            throw new Error('Advanced profile options include an unsupported key.');
          }
          const validCommand = (value: unknown) => {
            const command = asObject(value);
            return (
              typeof command?.command === 'string' &&
              command.command.trim() &&
              Array.isArray(command.args) &&
              command.args.every((arg) => typeof arg === 'string')
            );
          };
          function commands(value: string, label: string) {
            try {
              const rows = jsonArray(value);
              if (!rows.every(validCommand)) throw new Error();
              return rows;
            } catch {
              setTab('checks');
              throw new Error(`${label} need an executable and a list of literal arguments.`);
            }
          }
          for (const key of ['workspaceCommand', 'issueCommand', 'prCommand']) {
            if (options[key] != null && !validCommand(options[key])) {
              setTab(key === 'workspaceCommand' ? 'workspace' : 'integrations');
              throw new Error(
                'Each integration command needs an executable and a list of literal arguments.',
              );
            }
          }
          const next = {
            ...profile,
            ...options,
            id,
            name: name.trim(),
            path: path.trim(),
            cwd: cwd.trim(),
            strategy,
            verificationMode: mode,
            instructions,
            checks: commands(checks, 'Required checks'),
            setup: commands(setup, 'Setup commands'),
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
          {exists && (
            <button
              ref={removeButton}
              type="button"
              className="danger text-button profile-remove"
              disabled={busy || removing}
              onClick={() => setRemoving(true)}
            >
              Remove profile
            </button>
          )}
          <span className="form-note">Defaults for new tasks.</span>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy || removing}>
            {busy ? 'Saving…' : 'Save repository'}
          </button>
        </>
      }
    >
      <p className="form-note">
        {exists
          ? 'Existing tasks keep their saved profile.'
          : 'Each task gets its own worktree by default.'}
      </p>
      {removing && (
        <section className="profile-removal" aria-label="Remove repository profile">
          <h3>Remove {profile?.name}?</h3>
          <p>Existing tasks and worktrees are kept.</p>
          <div className="inline">
            <button
              ref={keepProfile}
              type="button"
              disabled={busy}
              onClick={() => {
                setRemoving(false);
              }}
            >
              Keep profile
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void removeProfile()}
            >
              Confirm removal
            </button>
          </div>
        </section>
      )}
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
            <label className="field">
              Working subdirectory
              <input
                required
                maxLength={2000}
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
              />
            </label>
            <section className="profile-detection" aria-label="Repository suggestions">
              <div className="section-heading">
                <div>
                  <h3>Detect settings</h3>
                  <p className="form-note">Suggestions from repository metadata.</p>
                </div>
                <button
                  type="button"
                  disabled={!path.trim() || detection.busy}
                  onClick={() => void detection.detect()}
                >
                  {detection.busy ? 'Detecting…' : 'Detect'}
                </button>
              </div>
              {detection.error && <Notice>{detection.error}</Notice>}
              {detection.busy && (
                <p role="status" className="form-note">
                  Reading metadata…
                </p>
              )}
              {detection.result && (
                <>
                  {detection.result.guidance.length > 0 && (
                    <p className="detected-guidance">
                      Guidance found:{' '}
                      {detection.result.guidance.map((file) => (
                        <code key={file}>{file}</code>
                      ))}
                    </p>
                  )}
                  <ul className="profile-detected-fields">
                    {detection.result.suggestions.map((item, index) => (
                      <li key={index}>
                        <div>
                          <strong>{item.label}</strong>
                          <code>
                            {typeof item.value === 'string'
                              ? item.value
                              : JSON.stringify([item.value.command, ...item.value.args])}
                          </code>
                          <small>{item.evidence}</small>
                        </div>
                        <button type="button" onClick={() => applySuggestion(item)}>
                          {item.field === 'checks'
                            ? 'Add check'
                            : item.field === 'setup'
                              ? 'Add setup'
                              : 'Use'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
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
            {mode === 'commands' ? (
              commandList(checks, 'Required checks', setChecks)
            ) : (
              <p className="form-note">The agent discovers checks from repository guidance.</p>
            )}
            {commandList(setup, 'Setup commands', setSetup)}
          </>
        )}
        {tab === 'guidance' && (
          <MarkdownEditor
            label="Repository instructions"
            value={instructions}
            onChange={setInstructions}
            uploads={uploads}
          />
        )}
        {tab === 'integrations' && (
          <>
            {commandField('issueCommand', 'Issue import command')}
            <p className="form-note">
              Include {'{ticket}'} as a separate argument. The provider must return the complete
              issue description and discussion.
            </p>
            {commandField('prCommand', 'Pull request command')}
            <fieldset className="profile-access">
              <legend>Analysis access</legend>
              {(['analysisCommands', 'networkAccess'] as const).map((key) => (
                <label className="check-row" key={key}>
                  <input
                    type="checkbox"
                    checked={asObject(options.developmentAccess)?.[key] === true}
                    onChange={(event) =>
                      setOption('developmentAccess', {
                        ...asObject(options.developmentAccess),
                        [key]: event.target.checked,
                      })
                    }
                  />
                  {key === 'analysisCommands'
                    ? 'Allow read-only analysis commands'
                    : 'Allow network access'}
                </label>
              ))}
              <label className="field">
                Additional writable folders
                <textarea
                  rows={3}
                  value={(Array.isArray(asObject(options.developmentAccess)?.writableRoots)
                    ? (asObject(options.developmentAccess)!.writableRoots as string[])
                    : []
                  ).join('\n')}
                  onChange={(event) =>
                    setOption('developmentAccess', {
                      ...asObject(options.developmentAccess),
                      writableRoots: event.target.value.split('\n').filter((value) => value.trim()),
                    })
                  }
                />
              </label>
            </fieldset>
            <details>
              <summary>Advanced profile options</summary>
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
