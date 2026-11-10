import { useEffect, useRef, useState } from 'react';
import { useMutation, useResource, useSession, request, Notice } from './Session';
import { Modal } from './Modal';
import { Select, ProviderIcon, providerName } from './UI';
import { ModelSelect } from './WorkspacePages';
import { asObject, asText } from './task-data';
import type { FullTask } from './TaskExtras';

type LiveTerminal = {
  available: boolean;
  message?: string;
  output?: string;
  terminal?: { session: string; attachCommand: string; interactive: boolean };
};
function Screen({ taskId, info }: { taskId: string; info: NonNullable<LiveTerminal['terminal']> }) {
  const host = useRef<HTMLDivElement>(null),
    { bootstrap } = useSession();
  const [status, setStatus] = useState('Connecting…');
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
    [takeover, setTakeover] = useState(false),
    [provider, setProvider] = useState(''),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState(''),
    [repositoryId, setRepository] = useState('');
  const task = current.data,
    rows =
      Array.isArray(task?.repositories) && task.repositories.length > 1
        ? task.repositories.map(asObject).filter(Boolean)
        : task
          ? [task]
          : [];
  const canTakeover =
    task && asText(task.workspaceRoot) && !['draft', 'manual'].includes(task.status);
  async function act(operation: string) {
    const latest = await request<FullTask>(`/api/tasks/${taskId}`);
    await mutation.run(`/api/tasks/${taskId}/${operation}`, {
      taskRevision: latest.taskRevision,
      ...(operation === 'takeover'
        ? { provider, model, effort, repositoryId: repositoryId || asObject(latest.repository)?.id }
        : { session: live.data?.terminal?.session }),
    });
    setTakeover(false);
  }
  return (
    <div className="terminal-panel">
      <div className="section-heading">
        <div>
          <h3>Terminal</h3>
          <small className="muted">
            {task?.status === 'manual' ? 'Automation paused' : 'Watch the agent or take control'}
          </small>
        </div>
        <div className="inline">
          {task?.status === 'manual' ? (
            <button
              onClick={() => void act('return-control').catch(() => {})}
              disabled={mutation.busy}
            >
              Return control
            </button>
          ) : (
            <button onClick={() => setTakeover(true)} disabled={!canTakeover || mutation.busy}>
              Take control
            </button>
          )}
          <button
            onClick={() => {
              setConnection((value) => value + 1);
              void live.refresh();
            }}
          >
            Reconnect
          </button>
        </div>
      </div>
      {(live.error || current.error || mutation.error) && (
        <Notice>{live.error || current.error || mutation.error}</Notice>
      )}
      {live.data?.available && live.data.terminal ? (
        <Screen key={`${taskId}:${connection}`} taskId={taskId} info={live.data.terminal} />
      ) : (
        <div className="terminal-empty">
          <strong>
            {task?.status === 'manual' ? 'Preparing your terminal…' : 'No live terminal'}
          </strong>
          <p>
            {asText(task?.workspaceRoot)
              ? 'Agent output appears during a run. Take control to open a shell or agent in this worktree.'
              : 'A workspace is created when the task starts.'}
          </p>
        </div>
      )}
      {live.data?.terminal?.attachCommand && (
        <details>
          <summary>Attach from your own terminal</summary>
          <code>{live.data.terminal.attachCommand}</code>
        </details>
      )}
      {takeover && (
        <Modal
          title="Take control"
          onClose={() => setTakeover(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void act('takeover').catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setTakeover(false)}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy}>
                Open terminal
              </button>
            </>
          }
        >
          <p>
            Stops the running agent and opens this worktree for you. Returning control requires
            fresh verification.
          </p>
          {rows.length > 1 && (
            <Select
              label="Repository"
              value={repositoryId || asText(asObject(rows[0]?.repository)?.id)}
              onChange={setRepository}
              options={rows.map((row) => ({
                value: asText(asObject(row?.repository)?.id),
                label: asText(asObject(row?.repository)?.name),
              }))}
            />
          )}
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
          {provider && (
            <>
              <ModelSelect provider={provider} value={model} onChange={setModel} />
              <Select
                label="Effort"
                value={effort}
                onChange={setEffort}
                options={['', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
                  value,
                  label: value || 'Default',
                }))}
              />
            </>
          )}
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </div>
  );
}
