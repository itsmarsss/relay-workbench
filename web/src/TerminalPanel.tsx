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
  // A person's own agent terminal: the task keeps its state and Relay runs no stage on it.
  agent?: boolean;
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
// The terminal wears the app's theme: its colours come from the same tokens as the page, with an
// ANSI palette picked to stay readable on that theme's surface.
function terminalTheme() {
  const tokens = getComputedStyle(document.documentElement),
    token = (name: string) => tokens.getPropertyValue(name).trim(),
    dark = document.documentElement.dataset.theme === 'dark';
  const ansi = dark
    ? ['#343a34', '#ff9d8f', '#86d3a2', '#f3cd72', '#adc6ff', '#c8b2ff', '#8fd6d6', '#c3cdc5']
    : ['#1f2a24', '#a12b1c', '#1a7f37', '#8a6100', '#1d4fa8', '#6a3fc0', '#0f6b70', '#5c6b61'];
  const bright = dark
    ? ['#6b776d', '#ffb3a5', '#9bdcab', '#f7dc97', '#c6d8ff', '#d9caff', '#aee6e6', '#f4f8f5']
    : ['#6b776d', '#c0392b', '#218a43', '#a06f00', '#2f66c9', '#7f55d6', '#168288', '#3d4a42'];
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  return {
    background: token('--surface'),
    foreground: token('--text'),
    cursor: token('--text'),
    cursorAccent: token('--surface'),
    selectionBackground: dark ? '#3d5247' : '#cfe3d6',
    ...Object.fromEntries(names.map((name, i) => [name, ansi[i]])),
    ...Object.fromEntries(
      names.map((name, i) => [`bright${name[0]!.toUpperCase()}${name.slice(1)}`, bright[i]]),
    ),
  };
}
function Screen({
  taskId,
  info,
  onWindows,
  onStatus,
}: {
  taskId: string;
  info: NonNullable<LiveTerminal['terminal']>;
  onWindows: () => void;
  onStatus: (status: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    { bootstrap } = useSession();
  const windowsChanged = useRef(onWindows),
    statusChanged = useRef(onStatus);
  windowsChanged.current = onWindows;
  statusChanged.current = onStatus;
  const setStatus = (status: string) => statusChanged.current(status);
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
        sending = false,
        typed = '',
        queue = Promise.resolve(),
        resizeTimer: number | undefined;
      const term = new Terminal({
        cursorBlink: info.interactive,
        disableStdin: !info.interactive,
        fontSize: 13,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
        // Rows touch, so block-drawing characters join up instead of leaving stripes.
        lineHeight: 1,
        scrollback: 5000,
        screenReaderMode: true,
        theme: terminalTheme(),
      });
      // Follow the appearance setting while the terminal is open.
      const themed = new MutationObserver(() => {
        term.options.theme = terminalTheme();
      });
      themed.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
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
      // Everything typed while a request is in flight goes out together in the next one, so a
      // key never waits behind a backlog.
      const flush = () => {
        if (sending || !typed) return;
        sending = true;
        const data = typed.slice(0, 4096);
        typed = typed.slice(data.length);
        send({ type: 'input', data });
        queue = queue.then(() => {
          sending = false;
          flush();
        });
      };
      const listener = term.onData((data) => {
        if (!info.interactive || !connected) return;
        // A program that asks for mouse tracking gets clicks, drags and the wheel, but not a
        // report for every pointer movement: those would swamp the keyboard.
        if (/^(\x1b\[<35;\d+;\d+[Mm])+$/.test(data)) return;
        typed += data;
        flush();
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
      // On the task page the screen takes the height left under it in the window, so its last
      // row is on screen without scrolling the page. Measured as if the page were at its top.
      const place = () => {
        const element = host.current,
          page = element?.closest<HTMLElement>('main.page-main');
        if (!element || !page || !element.closest('.task-detail-panel')) return;
        const top = element.getBoundingClientRect().top + page.scrollTop;
        element.style.setProperty(
          '--terminal-height',
          `${Math.max(260, Math.round(window.innerHeight - top - 28))}px`,
        );
      };
      place();
      window.addEventListener('resize', place);
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
        window.removeEventListener('resize', place);
        themed.disconnect();
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
    <div
      ref={host}
      className="live-terminal-screen"
      // Escape belongs to the program in the terminal: it must not also close a dialog or
      // drawer the terminal happens to sit in.
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    />
  );
}
type LiveRow = {
  seq: number;
  kind?: string;
  summary?: string;
  details?: string;
  at?: string;
  attemptId?: string;
  type?: string;
};
// What a running agent is doing, as it happens, in words: its messages, the tools it calls and
// what they returned. The raw terminal behind it is the agent's machine-readable event stream.
function AgentLive({ taskId, attemptId }: { taskId: string; attemptId: string }) {
  const [rows, setRows] = useState<LiveRow[]>([]),
    scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  useEffect(() => {
    let alive = true,
      last = 0,
      timer: number | undefined;
    const controller = new AbortController();
    async function load() {
      try {
        const page = await request<LiveRow[]>(
          `/api/tasks/${taskId}/events?${last ? `after=${last}` : 'before=0'}`,
          undefined,
          undefined,
          'GET',
          controller.signal,
        );
        if (!alive || !Array.isArray(page)) return;
        if (page.length) last = Math.max(last, ...page.map((row) => row.seq));
        const mine = page.filter((row) => row.type === 'activity' && row.attemptId === attemptId);
        if (mine.length)
          setRows((current) => {
            const seen = new Set(current.map((row) => row.seq));
            return [...current, ...mine.filter((row) => !seen.has(row.seq))].slice(-300);
          });
      } catch {}
      if (alive) timer = window.setTimeout(load, document.hidden ? 8000 : 1500);
    }
    void load();
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [taskId, attemptId]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [rows]);
  const clip = (text = '', lines = 8) => {
    const all = text.split('\n');
    return all.length > lines
      ? `${all.slice(0, lines).join('\n')}\n… ${all.length - lines} more lines`
      : text;
  };
  return (
    <div
      className="agent-live"
      ref={scroll}
      tabIndex={0}
      aria-label="Agent activity"
      onScroll={(event) => {
        const el = event.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {!rows.length && <p className="muted">Waiting for the agent’s first step…</p>}
      {rows.map((row) => {
        const time = row.at
          ? new Date(row.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          : '';
        if (row.kind === 'tool' && row.summary === 'Tool result')
          return (
            <div key={row.seq} className="agent-live-row is-result">
              <pre>{clip(row.details, 6)}</pre>
            </div>
          );
        if (row.kind === 'tool')
          return (
            <div key={row.seq} className="agent-live-row is-tool">
              <span className="agent-live-time">{time}</span>
              <strong>{row.summary || 'Tool'}</strong>
              {!!row.details && <pre>{clip(row.details, 4)}</pre>}
            </div>
          );
        return (
          <div
            key={row.seq}
            className={`agent-live-row is-message ${row.kind === 'handoff' ? 'is-handoff' : ''}`}
          >
            <span className="agent-live-time">{time}</span>
            {row.kind === 'handoff' && <strong>Result</strong>}
            <p>{row.summary}</p>
          </div>
        );
      })}
    </div>
  );
}
const lastAgentKey = 'relay-terminal-agent';
function lastAgent() {
  try {
    return localStorage.getItem(lastAgentKey) || '';
  } catch {
    return '';
  }
}
export function TerminalPanel({ taskId }: { taskId: string }) {
  const { bootstrap } = useSession(),
    // Every agent enabled in Settings can open in a terminal, plus a plain shell.
    agents = ['claude', 'codex', 'pi'].filter(
      (name) => asObject(asObject(bootstrap?.config.harnesses)?.[name])?.enabled === true,
    );
  const current = useResource<FullTask>(`/api/tasks/${taskId}`),
    live = useResource<LiveTerminal>(`/api/tasks/${taskId}/terminal`),
    mutation = useMutation();
  const [connection, setConnection] = useState(0),
    // Which dialog is open: taking control of the task, or adding a terminal beside the others.
    [opening, setOpening] = useState<'' | 'control' | 'window'>(''),
    // In the New terminal dialog: work beside the task (agent terminal) or take control of it.
    [mode, setMode] = useState<'agent' | 'control'>('agent'),
    [full, setFull] = useState(false),
    [status, setStatus] = useState('Connecting…'),
    // A running agent is shown in words by default; its raw event stream is one click away.
    [raw, setRaw] = useState(false),
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
  // Your own agent opens beside a task that is not running; its state is left alone.
  const canOpenAgent =
    !!task &&
    !!asText(task.workspaceRoot) &&
    !['running', 'queued', 'manual'].includes(task.status) &&
    !terminal;
  // Extra terminals open beside the first once a person has control.
  const canAdd = Boolean(terminal?.interactive && windows);
  async function act(operation: string, chosen = provider) {
    const latest = await request<FullTask>(`/api/tasks/${taskId}`);
    if (operation === 'agent-terminal' || operation === 'takeover')
      try {
        localStorage.setItem(lastAgentKey, chosen);
      } catch {}
    await mutation.run(`/api/tasks/${taskId}/${operation}`, {
      taskRevision: latest.taskRevision,
      ...(operation === 'takeover' || operation === 'agent-terminal'
        ? {
            provider: chosen,
            model: chosen === provider ? model : '',
            effort: chosen === provider ? effort : '',
            repositoryId: repositoryId || asObject(latest.repository)?.id,
          }
        : { session: terminal?.session }),
    });
    setOpening('');
    void live.refresh();
  }
  // "Claude" in the task header lands here and asks for the agent terminal straight away.
  useEffect(() => {
    let wanted = '';
    try {
      wanted = sessionStorage.getItem('relay-open-agent') || '';
    } catch {}
    if (wanted !== taskId || !task || live.loading) return;
    try {
      sessionStorage.removeItem('relay-open-agent');
    } catch {}
    if (canOpenAgent) {
      const remembered = lastAgent();
      setProvider(remembered === '' || agents.includes(remembered) ? remembered : agents[0] || '');
      setModel('');
      setEffort('');
      setMode('agent');
      setOpening('control');
    }
  }, [taskId, !!task, live.loading, canOpenAgent]);
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
      onClick={() => {
        setMode(canOpenAgent ? 'agent' : 'control');
        setOpening(canAdd ? 'window' : 'control');
      }}
      disabled={mutation.busy || !(canAdd || canTakeover || canOpenAgent)}
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
              : live.data?.agent
                ? 'Your agent terminal · Relay runs no stage on this task while it is open'
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
        <div className="terminal-frame" data-full={full}>
          <div className="terminal-bar">
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
                    <Icon name="terminal" size={14} />
                    {!terminal.interactive ? 'Agent' : windowName(item.name) || 'Terminal'}
                    {item.dead && <small>exited</small>}
                  </button>
                  {/* Extra terminals close on their own; the last one left ends the session. */}
                  {canAdd && (at > 0 || windows?.length === 1) && (
                    <button
                      type="button"
                      className="terminal-tab-close"
                      aria-label={`Close ${windowName(item.name)} terminal`}
                      title={at > 0 ? 'Close this terminal' : 'Close the terminal and keep control'}
                      disabled={mutation.busy}
                      onClick={() =>
                        void windowAction(
                          at > 0 ? { action: 'close', index: item.index } : { action: 'end' },
                        ).catch(() => {})
                      }
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {(canAdd || !terminal.interactive) && add}
            {!terminal.interactive && (
              <div className="segmented terminal-view" role="group" aria-label="Agent view">
                <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
                  Activity
                </button>
                <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
                  Raw output
                </button>
              </div>
            )}
            <p className="terminal-status" role="status">
              {status}
            </p>
            <button
              type="button"
              className="icon-button terminal-full"
              aria-label={full ? 'Exit full screen' : 'Full screen'}
              title={full ? 'Exit full screen' : 'Full screen'}
              aria-pressed={full}
              onClick={() => setFull(!full)}
            >
              <Icon name={full ? 'fold' : 'expand'} size={15} />
            </button>
          </div>
          {!terminal.interactive && !raw && task?.currentRun?.id && (
            <AgentLive taskId={taskId} attemptId={task.currentRun.id} />
          )}
          <div
            hidden={!terminal.interactive && !raw && !!task?.currentRun?.id}
            className="terminal-raw"
          >
            <Screen
              key={`${taskId}:${connection}`}
              taskId={taskId}
              info={terminal}
              onWindows={() => void live.refresh()}
              onStatus={setStatus}
            />
          </div>
        </div>
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
              ? live.data.stopped
                  .replace(/^./, (first) => first.toUpperCase())
                  .replace(/[.\s]*$/, '.')
              : asText(task?.workspaceRoot)
                ? 'An agent’s terminal appears here while it runs. Open your own to work in this worktree with a shell or an agent.'
                : 'A workspace is created when the task starts.'}
          </p>
          {asText(task?.workspaceRoot) && (
            <div className="inline">
              {canOpenAgent &&
                agents.map((name, index) => (
                  <button
                    key={name}
                    className={index === 0 ? 'primary' : undefined}
                    disabled={mutation.busy}
                    onClick={() => void act('agent-terminal', name).catch(() => {})}
                  >
                    <ProviderIcon provider={name} size={16} />
                    Open {providerName(name)}
                  </button>
                ))}
              {add}
            </div>
          )}
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
                : act(mode === 'agent' && canOpenAgent ? 'agent-terminal' : 'takeover')
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
          {opening === 'control' && canOpenAgent && (
            <label className="field">
              How
              <Select
                label="How"
                value={mode}
                onChange={(value) => setMode(value === 'control' ? 'control' : 'agent')}
                options={[
                  {
                    value: 'agent',
                    label: 'Work beside the task',
                    detail: 'Keeps its stage; Relay waits while the terminal is open',
                  },
                  {
                    value: 'control',
                    label: 'Take control',
                    detail: 'Pauses automation; needs fresh verification after',
                  },
                ]}
              />
            </label>
          )}
          {opening === 'control' && (mode === 'control' || !canOpenAgent) && (
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
                ...agents.map((value) => ({
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
