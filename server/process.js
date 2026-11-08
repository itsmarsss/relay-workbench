import { RuntimeBudget, RuntimeBudgetError } from './runtime-budget.js';
import { prepareTerminal } from './terminal.js';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));

export async function executableExists(command) {
  const paths = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? '').split(delimiter).map((p) => join(p, command));
  for (const p of paths) {
    try {
      await access(p, constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export async function runProcess(
  command,
  args,
  {
    cwd,
    input,
    signal,
    timeout = 3600000,
    progressPolicy,
    onBudget = () => {},
    onLine = () => {},
    maxBytes = 8 * 1024 * 1024,
    env = {},
    terminal,
    onTerminal = () => {},
  } = {},
) {
  if (signal?.aborted) throw new Error('Execution cancelled');
  const tty = terminal ? await prepareTerminal(command, args, { cwd, input, env, terminal }) : null;
  try {
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Execution cancelled'));
      let child;
      try {
        child = spawn(
          process.execPath,
          tty
            ? [fileURLToPath(new URL('./terminal-worker.js', import.meta.url)), tty.specPath]
            : [workerPath, command, ...args],
          {
            cwd,
            env: { ...process.env, ...env },
            shell: false,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          },
        );
      } catch (error) {
        reject(error);
        return;
      }
      let terminalResult;
      child.on('message', (message) => {
        if (message.type === 'terminal-result') terminalResult = message.result;
        if (message.type === 'terminal-ready') {
          try {
            onTerminal(tty.info);
          } catch (error) {
            stop(error.message);
          }
        }
      });
      let stdout = '',
        stderr = '',
        bytes = 0,
        failure = null;
      const buffers = { stdout: '', stderr: '' };
      const stop = (message) => {
        if (failure) return;
        failure = message instanceof Error ? message : new Error(message);
        kill('SIGTERM');
        hardKill = setTimeout(() => kill('SIGKILL'), 2000);
        hardKill.unref();
      };
      const kill = (sig) => {
        try {
          if (tty || process.platform === 'win32') child.kill(sig);
          else process.kill(-child.pid, sig);
        } catch {}
      };
      let hardKill;
      let timer;
      const budget = progressPolicy
        ? new RuntimeBudget({
            timeout,
            maxTimeout: progressPolicy.maxTimeout,
            progressWindow: progressPolicy.progressWindow,
          })
        : null;
      const armDeadline = () => {
        const deadline = budget?.softDeadline ?? Date.now() + timeout;
        timer = setTimeout(
          () => {
            if (!budget) {
              stop(`Execution timed out after ${Math.round(timeout / 60000)} minute(s)`);
              return;
            }
            let lastProgressAt;
            try {
              lastProgressAt = progressPolicy.lastProgressAt();
            } catch {}
            const action = budget.evaluate(Date.now(), lastProgressAt);
            const state = budget.snapshot(lastProgressAt);
            if (action === 'extend') {
              onBudget(state);
              armDeadline();
            } else if (action === 'wait') armDeadline();
            else
              stop(
                new RuntimeBudgetError(
                  'Execution budget exhausted; completed checks are preserved. Continue with more time or inspect the last recorded progress.',
                  state,
                ),
              );
          },
          Math.max(1, deadline - Date.now()),
        );
        timer.unref();
      };
      if (budget) onBudget(budget.snapshot(null));
      armDeadline();
      const abort = () => stop('Execution cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      const consume = (stream, chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          const error = new Error('Execution exceeded output limit; inspect the harness session');
          error.code = 'OUTPUT_LIMIT';
          stop(error);
          return;
        }
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
        buffers[stream] += chunk;
        const lines = buffers[stream].split('\n');
        buffers[stream] = lines.pop();
        for (const line of lines) {
          try {
            onLine(line, stream);
          } catch (error) {
            stop(error.message);
          }
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => consume('stdout', chunk));
      child.stderr.on('data', (chunk) => consume('stderr', chunk));
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') stop(error.message);
      });
      child.stdin.end(input ?? '');
      let spawnError;
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', (code, terminationSignal) => {
        clearTimeout(timer);
        clearTimeout(hardKill);
        signal?.removeEventListener('abort', abort);
        for (const [stream, line] of Object.entries(buffers))
          if (line) {
            try {
              onLine(line, stream);
            } catch (error) {
              failure ||= error;
            }
          }
        if (spawnError) reject(new Error(`Could not launch ${command}: ${spawnError.message}`));
        else if (failure) {
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
        } else
          resolve({ ...(terminalResult ?? { code, signal: terminationSignal }), stdout, stderr });
      });
    });
  } finally {
    await tty?.cleanup();
  }
}
