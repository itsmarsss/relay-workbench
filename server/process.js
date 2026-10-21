import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';

export async function executableExists(command) {
  const paths = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).map(p => join(p, command));
  for (const p of paths) { try { await access(p, constants.X_OK); return true; } catch {} }
  return false;
}

export function runProcess(command, args, { cwd, input, signal, timeout = 3600000, onLine = () => {}, maxBytes = 8 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Execution cancelled'));
    let child;
    try { child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', bytes = 0, failure = null;
    const buffers = { stdout: '', stderr: '' };
    const stop = message => {
      if (failure) return;
      failure = new Error(message);
      kill('SIGTERM');
      hardKill = setTimeout(() => kill('SIGKILL'), 2000);
      hardKill.unref();
    };
    const kill = sig => { try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); } catch {} };
    let hardKill;
    const timer = setTimeout(() => stop(`Execution timed out after ${Math.round(timeout / 60000)} minute(s)`), timeout);
    timer.unref();
    const abort = () => stop('Execution cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const consume = (stream, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { stop('Execution exceeded output limit; inspect the harness session'); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
      buffers[stream] += chunk;
      const lines = buffers[stream].split('\n');
      buffers[stream] = lines.pop();
      for (const line of lines) { try { onLine(line, stream); } catch (error) { stop(error.message); } }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => consume('stdout', chunk));
    child.stderr.on('data', chunk => consume('stderr', chunk));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error.message); });
    child.stdin.end(input ?? '');
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer); clearTimeout(hardKill); signal?.removeEventListener('abort', abort);
      for (const [stream, line] of Object.entries(buffers)) if (line) onLine(line, stream);
      if (spawnError) reject(new Error(`Could not launch ${command}: ${spawnError.message}`));
      else if (failure) reject(failure);
      else resolve({ code, signal: terminationSignal, stdout, stderr });
    });
  });
}
