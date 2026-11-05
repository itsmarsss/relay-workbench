import { workspaceSnapshots } from './workspace-snapshots.js';
import { excluded, installState, recoverRestore } from './backup-state.js';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, lstat, readFile, writeFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { requireValue, validateConfig, DEFAULT_CONFIG } from './domain.js';
import { workspaces } from './task-repositories.js';
const maxBytes = 512 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function safePath(name) {
  requireValue(
    typeof name === 'string' &&
      name.length > 0 &&
      name.length < 4096 &&
      !name.includes('\\') &&
      !name.includes('\0') &&
      !isAbsolute(name),
    'Invalid archive path',
  );
  const parts = name.split('/');
  requireValue(
    parts.every((p) => p && p !== '.' && p !== '..') && !excluded.has(parts[0].toLowerCase()),
    'Reserved or unsafe archive path',
  );
  return name;
}
async function filesIn(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (!prefix && excluded.has(entry.name.toLowerCase())) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = await lstat(join(root, name));
    requireValue(!stat.isSymbolicLink(), `Backup refuses symbolic link: ${name}`);
    if (stat.isDirectory()) files.push(...(await filesIn(root, name)));
    else {
      requireValue(stat.isFile(), `Unsupported backup file: ${name}`);
      requireValue(stat.size <= 64 * 1024 * 1024, `Backup file exceeds 64 MB: ${name}`);
      files.push(name);
    }
    requireValue(files.length <= 100000, 'Backup contains too many files');
  }
  return files;
}
function stateSnapshot(store) {
  return {
    config: store.config,
    tasks: store.all(),
    events: store.db
      .prepare('SELECT seq,body FROM events ORDER BY seq')
      .all()
      .map((r) => ({ seq: Number(r.seq), event: JSON.parse(r.body) })),
    meta: store.db.prepare('SELECT key,value FROM meta').all(),
  };
}
export async function createBackup(store) {
  const id = randomUUID();
  await mkdir(join(store.directory, 'backups'), { recursive: true, mode: 0o700 });
  const files = await filesIn(store.directory),
    state = stateSnapshot(store);
  const staging = join(store.directory, 'restore-staging', `export-${id}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  let snapshots;
  try {
    snapshots = await workspaceSnapshots(state.tasks, staging, id);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const archiveFiles = [
    ...files.map((name) => ({ name, root: store.directory })),
    ...snapshots.map((name) => ({ name, root: staging })),
  ];
  const path = join(store.directory, 'backups', `${id}.relay.gz`),
    temp = path + '.tmp';
  let total = 0;
  async function* records() {
    yield JSON.stringify({
      type: 'manifest',
      version: 1,
      createdAt: new Date().toISOString(),
      files: archiveFiles.length,
      tasks: state.tasks.length,
      external:
        'Workspace change patches and untracked files are included; full Git checkouts, ignored workspace files, Git object stores, provider-owned native sessions and harness credentials remain external. Restore requires those repositories and tools; workflows remain stopped.',
    }) + '\n';
    const initial = JSON.stringify({
      type: 'state',
      config: state.config,
      tasks: state.tasks,
      meta: state.meta,
    });
    total += Buffer.byteLength(initial);
    requireValue(total <= 64 * 1024 * 1024, 'Backup task metadata exceeds 64 MB');
    yield initial + '\n';
    for (const event of state.events) {
      const record = JSON.stringify({ type: 'event', ...event });
      total += Buffer.byteLength(record);
      requireValue(total <= maxBytes, 'Backup exceeds 512 MB');
      yield record + '\n';
    }
    for (const { name, root } of archiveFiles) {
      const bytes = await readFile(join(root, name));
      const mode = (await lstat(join(root, name))).mode & 0o100 ? 0o700 : 0o600;
      total += bytes.length;
      requireValue(total <= maxBytes, 'Backup exceeds 512 MB');
      yield JSON.stringify({
        type: 'file',
        path: safePath(name),
        sha256: digest(bytes),
        mode,
        data: bytes.toString('base64'),
      }) + '\n';
    }
    yield JSON.stringify({ type: 'end', files: archiveFiles.length, events: state.events.length }) +
      '\n';
  }
  try {
    await pipeline(
      Readable.from(records()),
      createGzip(),
      createWriteStream(temp, { mode: 0o600, flags: 'wx' }),
    );
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    id,
    filename: `${id}.relay.gz`,
    tasks: state.tasks.length,
    files: archiveFiles.length,
    downloadUrl: `/api/backups/${id}`,
    bytes: (await lstat(path)).size,
  };
}
function validateState(state) {
  requireValue(
    state && Array.isArray(state.tasks) && state.tasks.length <= 10000 && Array.isArray(state.meta),
    'Invalid backup state',
  );
  state.config = validateConfig(state.config);
  const ids = new Set();
  for (const task of state.tasks) {
    requireValue(
      task &&
        /^[a-f0-9-]{36}$/.test(task.id) &&
        !ids.has(task.id) &&
        typeof task.title === 'string' &&
        Array.isArray(task.attempts) &&
        Array.isArray(task.messages) &&
        Array.isArray(task.approvals) &&
        task.repository,
      'Invalid backup task',
    );
    requireValue(
      task.routing &&
        Object.keys(DEFAULT_CONFIG.routing).every((stage) =>
          ['codex', 'claude', 'pi'].includes(task.routing[stage]),
        ),
      'Invalid backup routing',
    );
    requireValue(
      task.messages.every((m) => m && typeof m.text === 'string') &&
        task.attempts.every(
          (a) =>
            a &&
            typeof a.id === 'string' &&
            typeof a.stage === 'string' &&
            typeof a.harness === 'string',
        ),
      'Invalid task history',
    );
    ids.add(task.id);
    requireValue(
      [
        'draft',
        'queued',
        'running',
        'awaiting_plan',
        'awaiting_final',
        'paused',
        'blocked',
        'interrupted',
        'manual',
        'completed',
        'cancelled',
      ].includes(task.status),
      'Invalid task status',
    );
    if (!task.demo)
      for (const entry of workspaces(task)) validateConfig({ repositories: [entry.repository] });
  }
  requireValue(
    state.meta.every((m) => typeof m.key === 'string' && typeof m.value === 'string'),
    'Invalid backup metadata',
  );
  return ids;
}
export async function previewBackup(source, stateDirectory) {
  const parent = stateDirectory ? join(stateDirectory, 'restore-staging') : tmpdir();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'relay-restore-'));
  const files = [];
  const paths = new Set();
  const events = [];
  let manifest,
    state,
    ids,
    ended = false,
    bytes = 0,
    compressed = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      compressed += chunk.length;
      callback(compressed > maxBytes ? new Error('Compressed backup exceeds 512 MB') : null, chunk);
    },
  });
  const expanded = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes * 2 ? new Error('Expanded backup exceeds 1 GB') : null, chunk);
    },
  });
  const input = expanded;
  input.setEncoding('utf8');
  const ingress = new PassThrough();
  const sourceError = (error) => ingress.destroy(error);
  source.on('error', sourceError);
  source.pipe(ingress);
  const unpacking = pipeline(ingress, limiter, createGunzip(), expanded);
  unpacking.catch(() => {});
  let buffer = '';
  async function* records() {
    for await (const chunk of input) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line;
      }
      requireValue(buffer.length <= 96 * 1024 * 1024, 'Oversized backup record');
    }
    await unpacking;
    requireValue(buffer.length === 0, 'Truncated backup record');
  }
  try {
    for await (const line of records()) {
      requireValue(!ended && line.length <= 96 * 1024 * 1024, 'Invalid or oversized backup record');
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('Invalid backup JSON');
      }
      if (!manifest) {
        requireValue(
          record.type === 'manifest' && record.version === 1,
          'Unsupported backup format',
        );
        manifest = record;
        continue;
      }
      if (record.type === 'state') {
        requireValue(!state, 'Duplicate backup state');
        state = record;
        ids = validateState(state);
      } else if (record.type === 'event') {
        requireValue(
          state &&
            Number.isSafeInteger(record.seq) &&
            record.seq > 0 &&
            record.seq > (events.at(-1)?.seq || 0) &&
            ids.has(record.event?.taskId),
          'Invalid backup event',
        );
        events.push({ seq: record.seq, event: record.event });
        requireValue(events.length <= 1000000, 'Too many events');
      } else if (record.type === 'file') {
        const name = safePath(record.path);
        requireValue(
          !paths.has(name) &&
            paths.size < 100000 &&
            typeof record.data === 'string' &&
            record.data.length % 4 === 0 &&
            /^[A-Za-z0-9+/]*={0,2}$/.test(record.data),
          'Invalid backup file',
        );
        const bytes = Buffer.from(record.data, 'base64');
        requireValue(
          bytes.length <= 64 * 1024 * 1024 &&
            bytes.toString('base64') === record.data &&
            digest(bytes) === record.sha256,
          'Backup file checksum mismatch',
        );
        paths.add(name);
        const path = join(directory, 'files', name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        requireValue(
          record.mode === undefined || [0o600, 0o700].includes(record.mode),
          'Unsafe backup file permissions',
        );
        await writeFile(path, bytes, { mode: record.mode ?? 0o600, flag: 'wx' });
        files.push(name);
      } else if (record.type === 'end') {
        requireValue(
          state &&
            record.files === files.length &&
            record.events === events.length &&
            manifest.files === files.length &&
            manifest.tasks === state.tasks.length,
          'Incomplete backup',
        );
        ended = true;
      } else throw new Error('Unknown backup record');
    }
    requireValue(ended, 'Truncated backup');
    return {
      id: randomUUID(),
      directory,
      state: { ...state, events },
      files,
      summary: {
        tasks: state.tasks.length,
        files: files.length,
        events: events.length,
        createdAt: manifest.createdAt,
        external: manifest.external,
        repositories: state.config.repositories.map((r) => ({
          id: r.id,
          name: r.name,
          path: r.path,
          setup: r.setup,
          checks: r.checks,
          issueCommand: r.issueCommand,
          prCommand: r.prCommand,
          workspaceCommand: r.workspaceCommand,
        })),
      },
    };
  } catch (error) {
    source.unpipe(ingress);
    source.resume();
    ingress.destroy();
    input.destroy();
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    source.removeListener('error', sourceError);
  }
}
export async function restoreBackup(store, preview) {
  const old = stateSnapshot(store),
    oldFiles = await filesIn(store.directory),
    rollback = join(preview.directory, 'rollback');
  await mkdir(rollback, { recursive: true, mode: 0o700 });
  // Every non-draft unfinished workflow requires an explicit resume and fresh checks.
  for (const task of preview.state.tasks) {
    if (!['draft', 'completed', 'cancelled'].includes(task.status)) {
      task.status = 'interrupted';
      task.stage = task.chosenApproach ? 'verify' : 'investigate';
      task.repositoryCursor = 0;
      task.reviewedFingerprint = null;
      task.verifiedFingerprint = null;
      task.manual = null;
      task.error =
        'Restored from backup. Inspect workspaces, configuration and native session availability before resuming.';
    }
    for (const attempt of task.attempts)
      if (attempt.status === 'running') {
        attempt.status = 'interrupted';
        attempt.finishedAt = new Date().toISOString();
      }
    for (const entry of workspaces(task))
      if (entry.submission?.status === 'running') entry.submission.status = 'interrupted';
  }
  const journalPath = join(store.directory, 'restore-journal.json');
  const journal = {
    directory: preview.directory,
    oldFiles,
    newFiles: preview.files,
    phase: 'installing',
  };
  requireValue(
    resolve(preview.directory).startsWith(resolve(store.directory, 'restore-staging') + '/'),
    'Restore preview must belong to this Relay instance',
  );
  await writeFile(join(preview.directory, 'old-state.json'), JSON.stringify(old), { mode: 0o600 });
  await writeFile(journalPath + '.tmp', JSON.stringify(journal), { mode: 0o600 });
  await rename(journalPath + '.tmp', journalPath);
  try {
    for (const name of oldFiles) {
      const target = join(rollback, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(join(store.directory, name), target);
    }
    for (const name of preview.files) {
      const target = join(store.directory, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try {
        if ((await lstat(target)).isDirectory()) await rm(target, { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await rename(join(preview.directory, 'files', name), target);
    }
    store.setConfig(preview.state.config);
    installState(store.db, preview.state);
    journal.phase = 'complete';
    await writeFile(journalPath + '.tmp', JSON.stringify(journal), { mode: 0o600 });
    await rename(journalPath + '.tmp', journalPath);
  } catch (error) {
    recoverRestore(store.directory, store.db);
    store.config = store.loadConfig();
    throw error;
  }
  await rm(journalPath, { force: true });
  await rm(preview.directory, { recursive: true, force: true });

  return { tasks: preview.state.tasks.length, files: preview.files.length };
}
export function backupPath(directory, id) {
  requireValue(/^[a-f0-9-]{36}$/.test(id), 'Invalid backup ID');
  return join(directory, 'backups', `${id}.relay.gz`);
}
