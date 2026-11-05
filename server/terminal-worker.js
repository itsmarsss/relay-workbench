import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
let server,
  stopping = false,
  polling;
const offsets = { stdout: 0, stderr: 0 };
function flush() {
  for (const name of ['stdout', 'stderr']) {
    const size = statSync(spec[name]).size;
    const fd = openSync(spec[name], 'r');
    try {
      while (offsets[name] < size) {
        const buffer = Buffer.alloc(Math.min(65536, size - offsets[name]));
        const n = readSync(fd, buffer, 0, buffer.length, offsets[name]);
        if (!n) break;
        offsets[name] += n;
        process[name].write(buffer.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
  }
}
function processTree() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    timeout: 250,
  });
  if (result.status !== 0) return new Map();
  return new Map(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [, pid, parent, birth] = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/) ?? [];
        return [Number(pid), { parent: Number(parent), birth }];
      }),
  );
}
function shutdown(code = 1) {
  if (stopping) return;
  stopping = true;
  clearInterval(polling);
  // Snapshot descendants before closing the PTY. Interactive shells may move
  // background jobs into separate process groups and then exit on HUP.
  const tree = processTree();
  const owned = new Set(server?.pid ? [server.pid] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, entry] of tree)
      if (!owned.has(pid) && owned.has(entry.parent)) {
        owned.add(pid);
        changed = true;
      }
  }
  for (const pid of owned) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  spawnSync('tmux', ['-S', spec.socket, 'kill-server'], { timeout: 250, stdio: 'ignore' });
  setTimeout(() => {
    // Check process birth times before signaling recorded PIDs after reparenting.
    const remaining = processTree();
    for (const pid of owned)
      if (tree.get(pid)?.birth && remaining.get(pid)?.birth === tree.get(pid)?.birth) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    rmSync(dirname(specPath), { recursive: true, force: true });
    process.exit(code);
  }, 1500);
}
function notify(message) {
  if (!process.connected) return shutdown();
  process.send(message, (error) => {
    if (error) shutdown();
  });
}
process.on('disconnect', () => shutdown());
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown());
server = spawn('tmux', ['-D', '-S', spec.socket, '-f', '/dev/null'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (chunk) => process.stderr.write(chunk));
server.on('error', (error) => {
  process.stderr.write(error.message);
  shutdown();
});
server.on('exit', () => {
  if (!stopping) shutdown();
});
let started = false;
let lastSessionCheck = 0;
polling = setInterval(() => {
  if (stopping) return;
  if (!started) {
    const ready = spawnSync('tmux', ['-S', spec.socket, 'show-options', '-s'], {
      stdio: 'ignore',
      timeout: 1000,
    });
    if (ready.status !== 0) return;
    const result = spawnSync(
      'tmux',
      [
        '-S',
        spec.socket,
        'new-session',
        '-d',
        '-s',
        spec.session,
        '-c',
        spec.cwd,
        process.execPath,
        fileURLToPath(new URL('./terminal-pane.js', import.meta.url)),
        specPath,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? 'Could not create terminal');
      shutdown();
      return;
    }
    started = true;
    notify({ type: 'terminal-ready' });
  }
  try {
    flush();
    if (Date.now() - lastSessionCheck > 1000) {
      lastSessionCheck = Date.now();
      const alive = spawnSync('tmux', ['-S', spec.socket, 'has-session', '-t', spec.session], {
        stdio: 'ignore',
        timeout: 1000,
      });
      if (alive.status !== 0) {
        process.stderr.write('The terminal closed before the command completed.\n');
        shutdown();
        return;
      }
    }
    const result = JSON.parse(readFileSync(spec.result, 'utf8'));
    flush();
    // Pass the actual command outcome to runProcess, independently of tmux.
    notify({ type: 'terminal-result', result });
    shutdown(0);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      process.stderr.write(error.message);
      shutdown();
    }
  }
}, 75);
