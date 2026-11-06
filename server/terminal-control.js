import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
function target(terminal) {
  if (!terminal?.socket || !/^relay-[a-zA-Z0-9_-]+$/.test(terminal.session ?? ''))
    throw new Error('Invalid terminal session');
  return terminal.session;
}
export function decodeTerminalOutput(text) {
  const bytes = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      const char = String.fromCodePoint(text.codePointAt(i));
      bytes.push(...Buffer.from(char));
      i += char.length;
    }
  }
  return Buffer.from(bytes);
}
export async function writeTerminal(terminal, data) {
  const session = target(terminal);
  const bytes = Buffer.from(data);
  // Hex key arguments preserve arbitrary keys and paste without a shell or tmux command parsing.
  await execute(
    'tmux',
    [
      '-S',
      terminal.socket,
      'send-keys',
      '-t',
      session,
      '-H',
      ...Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')),
    ],
    { timeout: 2000 },
  );
}
export async function resizeTerminal(terminal, cols, rows) {
  await execute(
    'tmux',
    [
      '-S',
      terminal.socket,
      'resize-window',
      '-t',
      target(terminal),
      '-x',
      String(cols),
      '-y',
      String(rows),
    ],
    { timeout: 2000 },
  );
}
export function connectTerminal(terminal, send, ended = () => {}) {
  const session = target(terminal);
  const child = spawn(
    'tmux',
    ['-S', terminal.socket, '-C', 'attach-session', '-f', 'ignore-size', '-t', session],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let closed = false,
    buffer = '',
    block = null,
    phase = 'attach',
    screen = [],
    queued = [];
  let pendingSnapshot = false;
  const timer = setTimeout(() => fail('Terminal connection timed out'), 5000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    child.stdin.end();
    child.kill('SIGTERM');
  };
  const fail = (message) => {
    if (closed) return;
    send({ type: 'error', message });
    close();
    ended();
  };
  function snapshot() {
    if (phase !== 'live') {
      pendingSnapshot = true;
      return;
    }
    phase = 'screen';
    queued = [];
    child.stdin.write(`capture-pane -e -p -t ${session}\n`);
  }
  function complete(lines) {
    if (phase === 'attach') {
      phase = 'live';
      snapshot();
    } else if (phase === 'screen') {
      screen = lines;
      phase = 'cursor';
      child.stdin.write(
        `display-message -p -t ${session} '#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}'\n`,
      );
    } else if (phase === 'cursor') {
      const [cols, rows, x, y] = (lines[0] ?? '').split(',').map(Number);
      if (![cols, rows, x, y].every(Number.isInteger) || cols < 2 || rows < 2)
        return fail('Invalid terminal dimensions');
      const data = Buffer.concat([
        Buffer.from('\x1b[2J\x1b[H' + screen.join('\r\n')),
        ...queued,
        Buffer.from(`\x1b[${y + 1};${x + 1}H`),
      ]);
      send({ type: 'snapshot', cols, rows, data: data.toString('base64') });
      phase = 'live';
      queued = [];
      clearTimeout(timer);
      if (pendingSnapshot) {
        pendingSnapshot = false;
        snapshot();
      }
    }
  }
  function line(text) {
    if (block) {
      if (text === `%end ${block.token}`) {
        const lines = block.lines;
        block = null;
        complete(lines);
      } else if (text === `%error ${block.token}`) fail('Terminal could not be attached');
      else block.lines.push(text);
      return;
    }
    if (text.startsWith('%begin ')) {
      block = { token: text.slice(7), lines: [] };
      return;
    }
    const output = text.match(/^%output %\d+ (.*)$/);
    if (output) {
      const bytes = decodeTerminalOutput(output[1]);
      if (phase === 'live') send({ type: 'output', data: bytes.toString('base64') });
      else if (phase === 'cursor') queued.push(bytes);
      return;
    }
    if (text.startsWith('%exit')) {
      close();
      ended();
      return;
    }
    if (text.startsWith('%layout-change ') || text.startsWith('%window-pane-changed ')) {
      snapshot();
      return;
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) return fail('Terminal output exceeded the connection buffer');
    let index;
    while (!closed && (index = buffer.indexOf('\n')) !== -1) {
      const text = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      line(text);
    }
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', (error) => fail(error.message));
  child.on('error', (error) => fail(error.message));
  child.on('close', () => {
    if (!closed) {
      close();
      ended();
    }
  });
  return close;
}
