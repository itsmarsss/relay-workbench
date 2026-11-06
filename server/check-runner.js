import { randomUUID, createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { runProcess } from './process.js';

// This runner executes explicit argv chosen by the agent. It contains no repository commands.
export async function runCheck(
  spec,
  { repositoryId, cwd, command, args, purpose = 'verification' },
  signal,
) {
  const repository = spec.repositories.find((r) => r.id === repositoryId);
  if (
    !['verification', 'diagnostic'].includes(purpose) ||
    !repository ||
    typeof command !== 'string' ||
    !command ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string')
  )
    throw Error('Invalid check command or repository');
  const root = realpathSync(repository.root);
  cwd = realpathSync(resolve(cwd));
  const rel = relative(root, cwd);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || resolve(root, rel) !== cwd)
    throw Error('Check working directory is outside its repository');
  mkdirSync(dirname(spec.journal), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const logPath = join(dirname(spec.journal), `check-${id}.log`);
  const lock = spec.lockDirectory;
  let ownsLock = false;
  while (!ownsLock) {
    if (signal?.aborted)
      throw Error('Execution cancelled while waiting for verification resources');
    try {
      mkdirSync(lock, { mode: 0o700 });
      ownsLock = true;
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, checkId: id }), {
        mode: 0o600,
      });
    } catch (error) {
      if (ownsLock) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
        try {
          process.kill(owner.pid, 0);
        } catch (check) {
          if (check.code === 'ESRCH') {
            // Supervised children need time to notice their parent's death and exit.
            await wait(3000);
            const current = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
            if (current.checkId === owner.checkId) rmSync(lock, { recursive: true, force: true });
          }
        }
      } catch (read) {
        if (read.code === 'ENOENT') {
          try {
            if (Date.now() - statSync(lock).mtimeMs > 5000)
              rmSync(lock, { recursive: true, force: true });
          } catch (stat) {
            if (stat.code !== 'ENOENT') throw stat;
          }
        }
      }
      await wait(100);
    }
  }
  const startedAt = new Date().toISOString();
  const identity = {
    id,
    purpose,
    attemptId: spec.attemptId,
    repositoryId,
    command,
    args,
    cwd,
    sourceFingerprint: spec.sourceFingerprint,
    signature: spec.signature,
    startedAt,
    logPath,
  };
  let lastProgressAt = null,
    lastDigest = '',
    lastWrite = 0,
    lastOutput = '';
  const publish = (status, extra = {}) =>
    writeFileSync(
      spec.progressPath,
      JSON.stringify({ ...identity, status, lastProgressAt, ...extra }),
      { mode: 0o600 },
    );
  let outcome;
  try {
    writeFileSync(logPath, '', { mode: 0o600 });
    appendFileSync(spec.journal, JSON.stringify({ ...identity, status: 'running' }) + '\n', {
      mode: 0o600,
    });
    publish('running');
    const result = await runProcess(command, args, {
      cwd,
      signal,
      timeout: spec.checkTimeoutMs,
      maxBytes: 32 * 1024 * 1024,
      env: {
        RELAY_BASE_COMMIT: repository.baseCommit ?? '',
        RELAY_REPOSITORY_ID: repositoryId,
        RELAY_WORKSPACES_JSON: JSON.stringify(
          Object.fromEntries(spec.repositories.map((r) => [r.id, r.cwd])),
        ),
      },
      onLine(line, stream) {
        appendFileSync(logPath, `[${stream}] ${line}\n`, { mode: 0o600 });
        const digest = createHash('sha256').update(line.trim()).digest('hex');
        if (line.trim() && digest !== lastDigest) {
          lastDigest = digest;
          lastProgressAt = Date.now();
          lastOutput = line.slice(-500);
          if (Date.now() - lastWrite > 1000) {
            publish('running', { lastOutput });
            lastWrite = Date.now();
          }
        }
      },
    });
    outcome = {
      ...identity,
      status: 'complete',
      code: result.code,
      finishedAt: new Date().toISOString(),
      summary:
        (result.stdout + '\n' + result.stderr).trim().slice(-4000) || `Exited ${result.code}`,
    };
  } catch (error) {
    outcome = {
      ...identity,
      status: 'interrupted',
      code: null,
      finishedAt: new Date().toISOString(),
      summary: error.message,
    };
  } finally {
    try {
      if (outcome) {
        appendFileSync(spec.journal, JSON.stringify(outcome) + '\n', { mode: 0o600 });
        publish(outcome.status, { lastOutput, code: outcome.code, finishedAt: outcome.finishedAt });
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return outcome;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort());
  try {
    const [specPath, repositoryId, cwd, ...tail] = process.argv.slice(2);
    const purpose = tail[0] === '--diagnostic' ? (tail.shift(), 'diagnostic') : 'verification';
    const [separator, command, ...args] = tail;
    if (separator !== '--')
      throw Error('Usage: check-runner spec repository cwd -- command [args]');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const outcome = await runCheck(
      spec,
      { repositoryId, cwd, command, args, purpose },
      controller.signal,
    );
    process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
    process.exitCode = outcome.status === 'complete' && outcome.code === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
