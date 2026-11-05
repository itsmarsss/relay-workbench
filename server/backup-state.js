import { readFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { requireValue } from './domain.js';
export const excluded = new Set([
  'relay.sqlite',
  'relay.sqlite-wal',
  'relay.sqlite-shm',
  'server.lock',
  'server.log',
  'config.json',
  'config.json.tmp',
  'relay.sqlite-journal',
  'backups',
  'worktrees',
  'restore-staging',
  'restore-journal.json',
  'restore-journal.json.tmp',
]);
export function installState(db, state) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM tasks;DELETE FROM events;DELETE FROM meta;');
    for (const task of state.tasks)
      db.prepare('INSERT INTO tasks(id,body) VALUES (?,?)').run(task.id, JSON.stringify(task));
    for (const row of state.events)
      db.prepare('INSERT INTO events(seq,task_id,body) VALUES (?,?,?)').run(
        row.seq,
        row.event.taskId,
        JSON.stringify(row.event),
      );
    for (const row of state.meta)
      db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(row.key, row.value);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function recoverRestore(directory, db) {
  const journalPath = join(directory, 'restore-journal.json');
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  requireValue(
    resolve(journal.directory).startsWith(resolve(directory, 'restore-staging') + '/'),
    'Unsafe restore recovery directory',
  );
  if (journal.phase !== 'complete') {
    const old = JSON.parse(readFileSync(join(journal.directory, 'old-state.json'), 'utf8'));
    for (const name of journal.newFiles) {
      // A missing staged source means the new file was installed before the crash.
      requireValue(safeRecoveryPath(name), 'Unsafe restore recovery path');
      if (!existsSync(join(journal.directory, 'files', name)))
        rmSync(join(directory, name), { force: true });
    }
    for (const name of journal.oldFiles) {
      requireValue(safeRecoveryPath(name), 'Unsafe restore recovery path');
      const saved = join(journal.directory, 'rollback', name);
      if (existsSync(saved)) {
        mkdirSync(dirname(join(directory, name)), { recursive: true, mode: 0o700 });
        if (existsSync(join(directory, name)))
          rmSync(join(directory, name), { recursive: true, force: true });
        renameSync(saved, join(directory, name));
      }
    }
    writeFileSync(join(directory, 'config.json.tmp'), JSON.stringify(old.config, null, 2) + '\n', {
      mode: 0o600,
    });
    renameSync(join(directory, 'config.json.tmp'), join(directory, 'config.json'));
    installState(db, old);
  }
  rmSync(journalPath, { force: true });
  rmSync(journal.directory, { recursive: true, force: true });
}
function safeRecoveryPath(name) {
  return (
    typeof name === 'string' &&
    !name.startsWith('/') &&
    !name.includes('\0') &&
    !name.includes('\\') &&
    name.split('/').every((p) => p && p !== '.' && p !== '..') &&
    !excluded.has(name.split('/')[0].toLowerCase())
  );
}
