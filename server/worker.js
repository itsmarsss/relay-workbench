import { spawn } from 'node:child_process';

// An IPC disconnect detects parent failure even after SIGKILL. Terminate the
// entire worker group so orphan harnesses cannot race a recovered attempt.
const [command, ...args] = process.argv.slice(2);
let stopping = false;
let child;
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    if (process.platform === 'win32') child?.kill('SIGTERM');
    else process.kill(-process.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    if (process.platform === 'win32') {
      child?.kill('SIGKILL');
      process.exit(1);
    } else {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        process.exit(1);
      }
    }
  }, 2000);
}
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  child = spawn(command, args, { shell: false, detached: false, stdio: 'inherit' });
  child.on('error', (error) => {
    process.stderr.write(`Could not launch ${command}: ${error.message}\n`);
    if (!stopping) process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) process.exit(code ?? (signal ? 1 : 0));
  });
} catch (error) {
  process.stderr.write(`Could not launch ${command}: ${error.message}\n`);
  process.exit(127);
}
