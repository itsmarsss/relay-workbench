import { decodeEvent } from './harness.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, openSync } from 'node:fs';

// Runs inside the pane's foreground process group. HUP from tmux and TERM
// from the supervisor terminate that entire group, including stubborn tools.
const [specPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
let stopping = false;
setInterval(() => {}, 1000);
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      process.exit(1);
    }
  }, 1500);
}
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, shutdown);
const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE },
  shell: false,
  detached: false,
  stdio: spec.interactive ? 'inherit' : [openSync(spec.input, 'r'), 'pipe', 'pipe'],
});
process.stdout.write(
  `Relay · ${spec.session}\nWorkspace: ${spec.cwd}\nDetach: Ctrl+B, then D. Use Relay's Take over action before editing.\n\n`,
);
const buffers = { stdout: '', stderr: '' };
function display(name, chunk) {
  if (!spec.harness || name === 'stderr') {
    process[name].write(chunk);
    return;
  }
  buffers[name] += chunk.toString();
  const lines = buffers[name].split('\n');
  buffers[name] = lines.pop();
  for (const line of lines) {
    const decoded = decodeEvent(spec.harness, line);
    for (const event of decoded.activities ?? (decoded.activity ? [decoded] : [])) {
      process.stdout.write(`${event.activity}\n${event.details ? event.details + '\n' : ''}\n`);
    }
    if (decoded.error) process.stderr.write(`${decoded.error}\n`);
    if (decoded.final !== undefined)
      process.stdout.write('Final handoff received. See Relay for the result.\n');
  }
}
if (!spec.interactive) {
  for (const name of ['stdout', 'stderr'])
    child[name].on('data', (chunk) => {
      appendFileSync(spec[name], chunk);
      display(name, chunk);
    });
}
child.on('error', (error) => {
  appendFileSync(spec.stderr, error.message);
  writeFileSync(spec.result, JSON.stringify({ code: 127, signal: null }));
});
child.on('close', (code, signal) => {
  if (stopping) return;
  writeFileSync(spec.result, JSON.stringify({ code, signal }));
  // Keep the pane alive until the supervisor drains the final output.
});
