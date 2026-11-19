import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Notice, request, useSession } from './Session';

type Command = { command: string; args: string[]; why: string; source: string };
type Note = { name: string; why: string; source: string };
type Proposal = {
  summary: string;
  cwd: string;
  setup: Command[];
  checks: Command[];
  services: Note[];
  environment: Note[];
  guidance: string;
};
type SetupState = {
  status: 'idle' | 'reading' | 'proposed' | 'testing' | 'tested' | 'failed' | 'error';
  summary: string;
  provider?: string;
  proposal?: Proposal;
  steps?: { display: string; kind: string; exit: number; output: string }[];
};
const show = (command: Command) => [command.command, ...command.args].join(' ');

// An agent reads a throwaway copy of the repository and proposes how to set it up; the person
// picks what to keep, Relay saves it and tests it once in another throwaway copy.
export function RepositorySetup({
  repositoryId,
  name,
  onClose,
  onSaved,
}: {
  repositoryId: string;
  name: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { bootstrap } = useSession();
  const [state, setState] = useState<SetupState | null>(null),
    [error, setError] = useState(''),
    [note, setNote] = useState(''),
    [keepSetup, setKeepSetup] = useState<boolean[]>([]),
    [keepChecks, setKeepChecks] = useState<boolean[]>([]),
    [useChecks, setUseChecks] = useState(true),
    [busy, setBusy] = useState(false);
  async function call(action: string, extra: Record<string, unknown> = {}) {
    if (!bootstrap) return;
    setError('');
    try {
      const next = await request<SetupState>('/api/repositories/setup', bootstrap.token, {
        repositoryId,
        action,
        ...extra,
      });
      setState(next);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not reach Relay.');
    }
  }
  useEffect(() => {
    void call('status');
  }, [repositoryId]);
  const running = state?.status === 'reading' || state?.status === 'testing';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void call('status'), 2000);
    return () => window.clearInterval(timer);
  }, [running]);
  const proposal = state?.proposal;
  useEffect(() => {
    if (state?.status === 'proposed' && proposal) {
      setKeepSetup(proposal.setup.map(() => true));
      setKeepChecks(proposal.checks.map(() => true));
    }
    if (state?.status === 'tested' || state?.status === 'failed') onSaved();
  }, [state?.status]);
  async function apply() {
    if (!proposal) return;
    setBusy(true);
    await call('apply', {
      useChecks,
      proposal: {
        ...proposal,
        setup: proposal.setup.filter((_, i) => keepSetup[i] !== false),
        checks: proposal.checks.filter((_, i) => keepChecks[i] !== false),
      },
    });
    setBusy(false);
  }
  async function ask() {
    setBusy(true);
    await call('propose', note.trim() ? { feedback: note.trim() } : {});
    setNote('');
    setBusy(false);
  }
  const reviewing = state?.status === 'proposed' && proposal;
  return (
    <Modal
      title={`Set up ${name} with an agent`}
      variant="drawer"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            {state?.status === 'tested' ? 'Done' : 'Close'}
          </button>
          {reviewing ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>
              Save and test
            </button>
          ) : (
            !running && (
              <button type="button" className="primary" disabled={busy} onClick={() => void ask()}>
                {state && state.status !== 'idle' ? 'Ask the agent again' : 'Start'}
              </button>
            )
          )}
        </>
      }
    >
      <div className="repository-setup">
        {(!state || state.status === 'idle') && (
          <p>
            An agent reads a throwaway copy of this repository: its README, contributor and agent
            guides, build files and CI workflows. It proposes how to prepare a worktree and check
            changes. Nothing is saved or run until you choose what to keep.
          </p>
        )}
        {running && (
          <p role="status" className="repository-setup-running">
            {state?.summary}
          </p>
        )}
        {state?.status === 'error' && <Notice>{state.summary}</Notice>}
        {proposal && state?.status !== 'reading' && (
          <>
            <p>{proposal.summary}</p>
            {proposal.cwd !== '.' && (
              <p>
                Work in <code>{proposal.cwd}</code>.
              </p>
            )}
            <CommandList
              title="Prepare each worktree"
              commands={proposal.setup}
              keep={keepSetup}
              onKeep={reviewing ? setKeepSetup : undefined}
            />
            <CommandList
              title="Checks"
              commands={proposal.checks}
              keep={keepChecks}
              onKeep={reviewing ? setKeepChecks : undefined}
            />
            {reviewing && proposal.checks.length > 0 && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={useChecks}
                  onChange={(event) => setUseChecks(event.target.checked)}
                />
                Verification must run these checks (it can still run others)
              </label>
            )}
            {(proposal.services.length > 0 || proposal.environment.length > 0) && (
              <div className="repository-setup-notes">
                <h3>Relay will note, not set up</h3>
                <ul>
                  {proposal.services.map((item) => (
                    <li key={'s' + item.name}>
                      <strong>{item.name}</strong> {item.why}{' '}
                      <small className="muted">{item.source}</small>
                    </li>
                  ))}
                  {proposal.environment.map((item) => (
                    <li key={'e' + item.name}>
                      <code>{item.name}</code> {item.why}{' '}
                      <small className="muted">{item.source}</small>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {proposal.guidance && (
              <details>
                <summary>Note for future agents</summary>
                <p>{proposal.guidance}</p>
              </details>
            )}
          </>
        )}
        {state?.steps && state.steps.length > 0 && (
          <div className="repository-setup-steps">
            <h3>Test in a fresh copy</h3>
            <ol>
              {state.steps.map((step, index) => (
                <li key={index} data-ok={step.exit === 0}>
                  <code>{step.display}</code> {step.exit === 0 ? '✓' : `exited ${step.exit}`}
                  {step.exit !== 0 && step.output && <pre>{step.output}</pre>}
                </li>
              ))}
            </ol>
            {!running && <p role="status">{state.summary}</p>}
          </div>
        )}
        {!running && state && state.status !== 'idle' && !reviewing && (
          <label className="field">
            Note for the agent (optional)
            <textarea
              rows={2}
              value={note}
              maxLength={4000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="For example: tests need Docker; use the api package"
            />
          </label>
        )}
        {error && <Notice>{error}</Notice>}
      </div>
    </Modal>
  );
}

function CommandList({
  title,
  commands,
  keep,
  onKeep,
}: {
  title: string;
  commands: Command[];
  keep: boolean[];
  onKeep?: (keep: boolean[]) => void;
}) {
  if (!commands.length) return null;
  return (
    <div className="repository-setup-commands">
      <h3>{title}</h3>
      <ul>
        {commands.map((command, index) => (
          <li key={index}>
            <label>
              {onKeep && (
                <input
                  type="checkbox"
                  checked={keep[index] !== false}
                  onChange={(event) => {
                    const next = [...keep];
                    next[index] = event.target.checked;
                    onKeep(next);
                  }}
                  aria-label={`Keep ${show(command)}`}
                />
              )}
              <span>
                <code>{show(command)}</code>
                <small>
                  {command.why} <span className="muted">· {command.source}</span>
                </small>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
