import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Notice, useMutation, useResource } from './Session';
import { Screen, type LiveTerminal } from './TerminalPanel';

type SetupAction = { label: string; command: string; args: string[]; display: string };
export type SetupItem = {
  id: string;
  label: string;
  why: string;
  required: boolean;
  status: 'ok' | 'missing' | 'attention' | 'off';
  detail: string;
  install?: SetupAction;
  login?: SetupAction;
};

const statusText = { ok: 'Ready', missing: 'Missing', attention: 'Needs you', off: 'Off' };

// What Relay relies on, each with what to do about it. Installs and logins run only after the
// exact command is shown and confirmed, in a terminal the person watches and types into.
export function SetupList({ onlyProblems = false }: { onlyProblems?: boolean }) {
  const check = useResource<SetupItem[]>('/api/setup'),
    terminal = useResource<LiveTerminal>('/api/tasks/setup/terminal'),
    mutation = useMutation();
  const [confirm, setConfirm] = useState<{ item: SetupItem; kind: 'install' | 'login' } | null>(
      null,
    ),
    [status, setStatus] = useState(''),
    // The last command run, kept after its terminal closes so its outcome stays on screen.
    [ran, setRan] = useState('');
  const live = terminal.data?.available ? terminal.data.terminal : undefined;
  // When the setup terminal closes (the install or login finished), check again.
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !live) void check.refresh();
    wasLive.current = !!live;
  }, [live]);
  const items = (check.data || []).filter(
    (item) => !onlyProblems || (item.status !== 'ok' && item.status !== 'off'),
  );
  async function run() {
    if (!confirm) return;
    await mutation.run('/api/setup/run', { item: confirm.item.id, action: confirm.kind });
    setRan(confirm.item[confirm.kind]?.display || '');
    setConfirm(null);
    await terminal.refresh();
  }
  const chosen = confirm ? confirm.item[confirm.kind] : undefined;
  return (
    <div className="setup-list">
      {check.loading && !check.data && <p role="status">Checking this machine…</p>}
      {check.error && <Notice>{check.error}</Notice>}
      {onlyProblems && check.data && items.length === 0 && (
        <p className="setup-all-ready">Everything Relay needs is installed and ready.</p>
      )}
      <ul>
        {items.map((item) => (
          <li key={item.id} data-status={item.status}>
            <span className="setup-status">{statusText[item.status]}</span>
            <div>
              <strong>
                {item.label}
                {item.required && item.status !== 'ok' && <small> · needed</small>}
              </strong>
              <p>
                {item.why}
                {item.detail && <span className="muted"> {item.detail}</span>}
              </p>
            </div>
            <span className="inline">
              {item.login && (
                <button
                  type="button"
                  disabled={!!live || mutation.busy}
                  onClick={() => setConfirm({ item, kind: 'login' })}
                >
                  {item.login.label}
                </button>
              )}
              {item.status === 'missing' &&
                !item.install &&
                ['claude', 'codex', 'pi'].includes(item.id) && (
                  <a className="button-link" href="#agents">
                    Turn it off
                  </a>
                )}
              {item.install && (
                <button
                  type="button"
                  disabled={!!live || mutation.busy}
                  onClick={() => setConfirm({ item, kind: 'install' })}
                >
                  {item.install.label}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {check.data && (
        <button type="button" className="text-button" onClick={() => void check.refresh()}>
          Check again
        </button>
      )}
      {!live && ran && (
        <p role="status" className="setup-ran">
          Finished <code>{ran}</code>. Relay checked again; the list above is current.
        </p>
      )}
      {live && (
        <div className="terminal-frame setup-terminal">
          <div className="terminal-bar">
            <p className="terminal-status" role="status">
              {/exit status|closed/i.test(status)
                ? 'Finished. Read the output, then close it; Relay checks again.'
                : status || 'Running in a terminal; type here if it asks for anything.'}
            </p>
            <button
              type="button"
              onClick={() =>
                void mutation
                  .run('/api/tasks/setup/terminal-window', {
                    session: live.session,
                    action: 'end',
                  })
                  .then(() => terminal.refresh())
                  .catch(() => {})
              }
            >
              Close
            </button>
          </div>
          <div className="terminal-raw">
            <Screen taskId="setup" info={live} onWindows={() => {}} onStatus={setStatus} />
          </div>
        </div>
      )}
      {confirm && chosen && (
        <Modal
          title={`${chosen.label}?`}
          onClose={() => setConfirm(null)}
          onSubmit={(event) => {
            event.preventDefault();
            void run().catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy}>
                Run it
              </button>
            </>
          }
        >
          <p>
            Relay will run this in a terminal on this page, from your home folder. You can watch it
            and type a password or login code if it asks.
          </p>
          <pre className="setup-command">
            <code>{chosen.display}</code>
          </pre>
          <p className="form-note">
            {confirm.item.label}: {confirm.item.why}
          </p>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </div>
  );
}
