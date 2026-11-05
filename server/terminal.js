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
