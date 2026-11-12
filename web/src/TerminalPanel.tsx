import { useEffect, useRef, useState } from 'react';
import { useMutation, useResource, useSession, request, Notice } from './Session';
import { Modal } from './Modal';
import { Select, ProviderIcon, providerName } from './UI';
import { Icon } from './Icons';
import { EffortSelect, ModelSelect } from './WorkspacePages';
import { asObject, asText } from './task-data';
import type { FullTask } from './TaskExtras';

type LiveTerminal = {
  available: boolean;
  message?: string;
  // Why the last interactive terminal failed to start, when it did.
  stopped?: string;
  output?: string;
  terminal?: { session: string; attachCommand: string; interactive: boolean };
  // The session's tmux windows: the first is the terminal it was started for.
  windows?: TerminalWindow[];
};
type TerminalWindow = { index: number; name: string; active: boolean; dead: boolean };
function windowName(name: string) {
  return /^(sh|shell|zsh|bash)$/.test(name)
    ? 'Shell'
    : ['codex', 'claude', 'pi'].includes(name)
      ? providerName(name)
      : name;
}
function Screen({
  taskId,
  info,
  onWindows,
}: {
  taskId: string;
  info: NonNullable<LiveTerminal['terminal']>;
  onWindows: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    { bootstrap } = useSession();
  const [status, setStatus] = useState('Connecting…');
  const windowsChanged = useRef(onWindows);
  windowsChanged.current = onWindows;
  useEffect(() => {
    if (!host.current || !bootstrap) return;
    let stopped = false,
      cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (stopped || !host.current) return;
      const controller = new AbortController();
      let disposed = false,
        connected = false,
        inputFailed = false,
        queue = Promise.resolve(),
        resizeTimer: number | undefined;
      const term = new Terminal({
        cursorBlink: info.interactive,
        disableStdin: !info.interactive,
        fontSize: 14,
        lineHeight: 1.2,
        scrollback: 5000,
        screenReaderMode: true,
        theme: { background: '#101820', foreground: '#e4eaf0' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      term.textarea?.setAttribute(
        'aria-label',
        info.interactive ? 'Interactive terminal' : 'Agent terminal output',
      );
      const send = (body: Record<string, unknown>) => {
        queue = queue
          .then(async () => {
            if (disposed || inputFailed) return;
            await request(
              `/api/tasks/${taskId}/terminal-input`,
              bootstrap.token,
              { session: info.session, ...body },
              'POST',
              controller.signal,
            );
          })
          .catch((error) => {
            if (!disposed) {
              inputFailed = true;
              connected = false;
              setStatus(String(error.message || 'Terminal input failed'));
            }
          });
      };
      const listener = term.onData((data) => {
        if (!info.interactive || !connected) return;
        let chunk = '';
        for (const char of data) {
          chunk += char;
          if (chunk.length >= 2048) {
            send({ type: 'input', data: chunk });
            chunk = '';
          }
        }
        if (chunk) send({ type: 'input', data: chunk });
      });
      const resize = () => {
        if (!disposed && host.current && host.current.clientWidth > 80) {
          fit.fit();
          if (info.interactive && connected)
            send({
              type: 'resize',
              cols: Math.max(20, Math.min(500, term.cols)),
              rows: Math.max(5, Math.min(200, term.rows)),
            });
        }
      };
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(resize, 100);
      });
      observer.observe(host.current);
      async function stream() {
        let ended = false;
        try {
          const response = await fetch(
            `/api/tasks/${taskId}/terminal-stream?session=${encodeURIComponent(info.session)}`,
            { headers: { 'X-Relay-Token': bootstrap!.token }, signal: controller.signal },
          );
          if (!response.ok || !response.body) throw new Error('Could not connect to terminal');
          const reader = response.body.getReader(),
            decoder = new TextDecoder();
          let pending = '';
          while (!disposed) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            if (pending.length > 2 * 1024 * 1024)
              throw new Error('Terminal stream exceeded buffer');
            let end: number;
            while ((end = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              if (!frame.startsWith('data: ')) continue;
              const message = JSON.parse(frame.slice(6));
              if (message.type === 'closed' || message.type === 'error') {
                connected = false;
                ended = true;
                setStatus(message.message || 'Terminal closed');
                continue;
              }
              if (message.type === 'windows') windowsChanged.current();
              if (!['snapshot', 'output'].includes(message.type)) continue;
              if (message.type === 'snapshot') {
                term.resize(message.cols, message.rows);
                connected = true;
                setStatus(info.interactive ? 'You have control' : 'Live · viewing agent output');
              }
              term.write(
                Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)),
                () => {
                  if (message.type === 'snapshot' && info.interactive) resize();
                },
              );
            }
          }
          if (!disposed && !ended) {
            connected = false;
            setStatus('Terminal disconnected. Reconnect to resume.');
          }
        } catch (error) {
          connected = false;
          controller.abort();
          if (!disposed)
            setStatus(error instanceof Error ? error.message : 'Terminal disconnected');
        }
      }
      void stream();
      resize();
      cleanup = () => {
        disposed = true;
        controller.abort();
        clearTimeout(resizeTimer);
        observer.disconnect();
        listener.dispose();
        term.dispose();
      };
    })().catch((error) => {
      if (!stopped) setStatus(error.message || 'Could not load terminal');
    });
    return () => {
      stopped = true;
      cleanup();
    };
  }, [taskId, info.session, info.interactive, bootstrap?.token]);
  return (
    <>
      <p className="terminal-status" role="status">
        {status}
      </p>
      <div ref={host} className="live-terminal-screen" />
    </>
  );
}
export function TerminalPanel({ taskId }: { taskId: string }) {
  const current = useResource<FullTask>(`/api/tasks/${taskId}`),
    live = useResource<LiveTerminal>(`/api/tasks/${taskId}/terminal`),
    mutation = useMutation();
  const [connection, setConnection] = useState(0),
    // Which dialog is open: taking control of the task, or adding a terminal beside the others.
    [opening, setOpening] = useState<'' | 'control' | 'window'>(''),
    [provider, setProvider] = useState(''),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState(''),
    [repositoryId, setRepository] = useState('');
  const task = current.data,
    terminal = live.data?.available ? live.data.terminal : undefined,
    windows = terminal ? live.data?.windows : undefined,
    rows =
      Array.isArray(task?.repositories) && task.repositories.length > 1
        ? task.repositories.map(asObject).filter(Boolean)
        : task
          ? [task]
          : [];
  // Under manual control with no terminal left (it closed, failed, or Relay restarted), another
  // one can be opened without handing control back first.
  const lost = task?.status === 'manual' && live.data?.available === false;
  const canTakeover =
    task && asText(task.workspaceRoot) && (lost || !['draft', 'manual'].includes(task.status));
  // Extra terminals open beside the first once a person has control.
  const canAdd = Boolean(terminal?.interactive && windows);
  async function act(operation: string) {
    const latest = await request<FullTask>(`/api/tasks/${taskId}`);
    await mutation.run(`/api/tasks/${taskId}/${operation}`, {
      taskRevision: latest.taskRevision,
      ...(operation === 'takeover'
        ? { provider, model, effort, repositoryId: repositoryId || asObject(latest.repository)?.id }
        : { session: terminal?.session }),
    });
    setOpening('');
  }
  async function windowAction(body: Record<string, unknown>) {
    await mutation.run(`/api/tasks/${taskId}/terminal-window`, {
      session: terminal?.session,
      ...body,
    });
    setOpening('');
    void live.refresh();
  }
  const add = (
    <button
      type="button"
      className="terminal-tab-add"
      onClick={() => setOpening(canAdd ? 'window' : 'control')}
      disabled={mutation.busy || !(canAdd || canTakeover)}
    >
      <Icon name="plus" size={14} />
      New terminal
    </button>
  );
  return (
    <div className="terminal-panel">
      <div className="section-heading">
        <div>
          <h3>Terminals</h3>
          <small className="muted">
            {task?.status === 'manual'
              ? 'You have control · automation is paused'
              : terminal
                ? 'Watching the agent · open a terminal to take control'
                : 'Open a shell or an agent in this task’s worktree'}
          </small>
        </div>
        <div className="inline">
          {task?.status === 'manual' && (
            <button
              onClick={() => void act('return-control').catch(() => {})}
              disabled={mutation.busy}
            >
              Return control
            </button>
          )}
          {terminal && (
            <button
              onClick={() => {
                setConnection((value) => value + 1);
                void live.refresh();
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      </div>
      {(live.error || current.error || (!opening && mutation.error)) && (
        <Notice>{live.error || current.error || mutation.error}</Notice>
      )}
      {terminal ? (
        <>
          <div className="terminal-tabs" role="tablist" aria-label="Terminals">
            {(windows || [{ index: 0, name: '', active: true, dead: false }]).map((item, at) => (
              <span key={item.index} className="terminal-tab" data-active={item.active}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={item.active}
                  disabled={mutation.busy}
                  onClick={() => {
                    if (!item.active && canAdd)
                      void windowAction({ action: 'select', index: item.index }).catch(() => {});
                  }}
                >
                  {!terminal.interactive ? 'Agent' : windowName(item.name) || 'Terminal'}
                  {item.dead && <small>exited</small>}
                </button>
                {canAdd && at > 0 && (
                  <button
                    type="button"
                    className="terminal-tab-close"
                    aria-label={`Close ${windowName(item.name)} terminal`}
                    disabled={mutation.busy}
                    onClick={() =>
                      void windowAction({ action: 'close', index: item.index }).catch(() => {})
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </span>
            ))}
            {(canAdd || !terminal.interactive) && add}
          </div>
          <Screen
            key={`${taskId}:${connection}`}
            taskId={taskId}
            info={terminal}
            onWindows={() => void live.refresh()}
          />
        </>
      ) : (
        <div className="terminal-empty">
          <strong>
            {lost && live.data?.stopped
              ? 'The terminal could not start'
              : live.loading && !live.data
                ? 'Looking for terminals…'
                : 'No terminals open'}
          </strong>
          <p>
            {lost && live.data?.stopped
              ? `${live.data.stopped}.`
              : asText(task?.workspaceRoot)
                ? 'An agent’s terminal appears here while it runs. Open your own to work in this worktree with a shell or an agent.'
                : 'A workspace is created when the task starts.'}
          </p>
          {asText(task?.workspaceRoot) && add}
        </div>
      )}
      {terminal?.attachCommand && (
        <details>
          <summary>Attach from your own terminal</summary>
          <code>{terminal.attachCommand}</code>
        </details>
      )}
      {opening && (
        <Modal
          title="New terminal"
          onClose={() => setOpening('')}
          onSubmit={(e) => {
            e.preventDefault();
            void (
              opening === 'window'
                ? windowAction({ action: 'new', provider, model, effort })
                : act('takeover')
            ).catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setOpening('')}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy}>
                Open terminal
              </button>
            </>
          }
        >
          {opening === 'control' && (
            <p>
              {lost
                ? 'Opens this worktree for you again. Returning control requires fresh verification.'
                : terminal
                  ? 'Stops the running agent and gives you control of this worktree. Returning control requires fresh verification.'
                  : 'Gives you control of this worktree and pauses automation. Returning control requires fresh verification.'}
            </p>
          )}
          {opening === 'control' && rows.length > 1 && (
            <label className="field">
              Repository
              <Select
                label="Repository"
                value={repositoryId || asText(asObject(rows[0]?.repository)?.id)}
                onChange={setRepository}
                options={rows.map((row) => ({
                  value: asText(asObject(row?.repository)?.id),
                  label: asText(asObject(row?.repository)?.name),
                }))}
              />
            </label>
          )}
          <label className="field">
            Open
            <Select
              label="Open"
              value={provider}
              onChange={(value) => {
                setProvider(value);
                setModel('');
                setEffort('');
              }}
              options={[
                { value: '', label: 'Shell' },
                ...['codex', 'claude', 'pi'].map((value) => ({
                  value,
                  label: providerName(value),
                  icon: <ProviderIcon provider={value} size={22} />,
                })),
              ]}
            />
          </label>
          {provider && (
            <>
              <label className="field">
                Model
                <ModelSelect provider={provider} value={model} onChange={setModel} />
              </label>
              <label className="field">
                Effort
                <EffortSelect provider={provider} value={effort} onChange={setEffort} />
              </label>
            </>
          )}
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </div>
  );
}
