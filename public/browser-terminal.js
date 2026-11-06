import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';

let active;
export function syncBrowserTerminal(task, token, restoreFocus = false) {
  const placeholder = document.querySelector('[data-browser-terminal]');
  const session = task?.status === 'manual' && task.manual?.active ? task.manual.session : null;
  const key = session ? `${task.id}:${session}` : null;
  if (!placeholder || !key) {
    active?.dispose();
    active = null;
    return;
  }
  if (active?.key === key) {
    if (placeholder !== active.host) placeholder.replaceWith(active.host);
    active.refresh(restoreFocus);
    return;
  }
  active?.dispose();
  const host = placeholder;
  const status = () => document.querySelector('[data-browser-terminal-status]');
  let statusText = 'Connecting…';
  const update = (text) => {
    statusText = text;
    if (status()) status().textContent = text;
  };
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    lineHeight: 1.25,
    scrollback: 5000,
    fontFamily: 'SFMono-Regular, Consolas, monospace',
    theme: { background: '#17251f', foreground: '#f0f5ed', cursor: '#d4efb8' },
    allowProposedApi: false,
    screenReaderMode: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host);
  terminal.textarea.setAttribute('aria-label', 'Interactive terminal');
  let stopped = false,
    connected = false,
    inputFailed = false,
    queue = Promise.resolve(),
    dimensions = '',
    sizeTimer;
  const endpoint = `/api/tasks/${encodeURIComponent(task.id)}/terminal-input?session=${encodeURIComponent(session)}`;
  const post = (data) => {
    queue = queue
      .then(async () => {
        if (stopped || inputFailed) return;
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token },
          body: JSON.stringify(data),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Terminal input failed');
      })
      .catch((error) => {
        connected = false;
        inputFailed = true;
        source.close();
        update(`${error.message}. Reopen Live terminals to reconnect.`);
      });
  };
  const fit = () => {
    if (stopped || !host.isConnected || host.clientWidth < 100) return;
    fitAddon.fit();
    const size = `${terminal.cols}:${terminal.rows}`;
    if (connected && size !== dimensions) {
      dimensions = size;
      post({
        type: 'resize',
        cols: Math.max(20, Math.min(500, terminal.cols)),
        rows: Math.max(5, Math.min(200, terminal.rows)),
      });
    }
  };
  const input = (data) => {
    if (!connected || stopped) {
      update('Terminal is reconnecting. Wait before typing.');
      return;
    }
    // Split by code points so a long paste cannot split a surrogate pair.
    let chunk = '';
    for (const char of data) {
      chunk += char;
      if (chunk.length >= 2048) {
        post({ type: 'input', data: chunk });
        chunk = '';
      }
    }
    if (chunk) post({ type: 'input', data: chunk });
  };
  const onData = terminal.onData(input);
  const source = new EventSource(
    `/api/tasks/${encodeURIComponent(task.id)}/terminal-stream?session=${encodeURIComponent(session)}`,
  );
  source.onmessage = (event) => {
    if (stopped) return;
    const message = JSON.parse(event.data);
    if (['error', 'closed'].includes(message.type)) {
      connected = false;
      update(message.message);
      source.close();
      return;
    }
    if (!['snapshot', 'output'].includes(message.type)) return;
    if (message.type === 'snapshot') {
      connected = true;
      dimensions = `${message.cols}:${message.rows}`;
      terminal.resize(message.cols, message.rows);
      update('Connected · type directly below');
    }
    const data = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
    terminal.write(data, () => {
      if (message.type === 'snapshot') fit();
    });
  };
  source.onerror = () => {
    connected = false;
    update('Disconnected · reconnecting automatically');
  };
  const resize = new ResizeObserver(() => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(fit, 80);
  });
  resize.observe(host);
  const keys = {
    interrupt: '\x03',
    escape: '\x1b',
    tab: '\t',
    enter: '\r',
    up: '\x1b[A',
    down: '\x1b[B',
  };
  const keyHandler = (event) => {
    const button = event.target.closest('[data-terminal-key]');
    if (!button) return;
    if (button.dataset.terminalKey === 'focus') terminal.focus();
    else {
      input(keys[button.dataset.terminalKey]);
      terminal.focus();
    }
  };
  document.addEventListener('click', keyHandler);
  active = {
    key,
    host,
    refresh(focus) {
      update(statusText);
      fit();
      if (focus) terminal.focus();
    },
    dispose() {
      stopped = true;
      clearTimeout(sizeTimer);
      source.close();
      resize.disconnect();
      onData.dispose();
      terminal.dispose();
      document.removeEventListener('click', keyHandler);
    },
  };
  fit();
  terminal.focus();
}
