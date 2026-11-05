import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function prepareTerminal(command, args, options) {
  // A short private socket path also works on macOS's small Unix path limit.
  const directory = await mkdtemp(join(tmpdir(), 'relay-tty-'));
  const session = `relay-${options.terminal.name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)}`;
  const socket = join(directory, 'tmux.sock');
  const specPath = join(directory, 'launch.json');
  const spec = {
    command,
    args,
    cwd: options.cwd,
    env: options.env ?? {},
    interactive: options.terminal.interactive === true,
    harness: options.terminal.harness,
    session,
    socket,
    input: join(directory, 'input.txt'),
    stdout: join(directory, 'stdout'),
    stderr: join(directory, 'stderr'),
    result: join(directory, 'result.json'),
  };
  try {
    for (const name of ['stdout', 'stderr']) await writeFile(spec[name], '', { mode: 0o600 });
    await writeFile(spec.input, options.input ?? '', { mode: 0o600 });
    await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  return {
    specPath,
    info: {
      session,
      socket,
      attachCommand: `tmux -S ${quote(socket)} attach-session -t ${quote(session)}`,
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const execute = promisify(execFile);
export async function captureTerminal(terminal) {
  try {
    const { stdout } = await execute(
      'tmux',
      ['-S', terminal.socket, 'capture-pane', '-p', '-J', '-S', '-200', '-t', terminal.session],
      { timeout: 1500, maxBuffer: 262144, encoding: 'utf8' },
    );
    // Keep printable text, tabs and newlines; browser rendering never interprets terminal escapes.
    const output = stdout
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .trimEnd();
    return { available: true, output, capturedAt: new Date().toISOString() };
  } catch {
    return {
      available: false,
      output: '',
      message: 'Terminal is no longer available. Retained output remains in the activity thread.',
    };
  }
}
