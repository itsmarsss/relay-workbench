import { recoverRestore } from './backup-state.js';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, validateConfig } from './domain.js';

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.lockPath = join(directory, 'server.lock');
    this.ownsLock = false;
    this.acquireLock();
    try {
      this.db = new DatabaseSync(join(directory, 'relay.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      recoverRestore(directory, this.db);
      this.listeners = new Set();
      this.config = this.loadConfig();
    } catch (error) {
      try {
        this.db?.close();
      } catch {}
      this.releaseLock();
      throw error;
    }
  }
  acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        this.ownsLock = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(readFileSync(this.lockPath, 'utf8'));
        try {
          process.kill(pid, 0);
          throw new Error(`Relay state is already owned by process ${pid}`);
        } catch (check) {
          if (check.code !== 'ESRCH') throw check;
          unlinkSync(this.lockPath);
        }
      }
    }
    throw new Error('Could not acquire state lock');
  }
  releaseLock() {
    if (!this.ownsLock) return;
    this.ownsLock = false;
    try {
      unlinkSync(this.lockPath);
    } catch {}
  }
  loadConfig() {
    try {
      return validateConfig(JSON.parse(readFileSync(join(this.directory, 'config.json'), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
      throw error;
    }
  }
  setConfig(raw) {
    const config = validateConfig(raw);
    const temp = join(this.directory, 'config.json.tmp');
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, join(this.directory, 'config.json'));
    this.config = config;
    return config;
  }
  all() {
    return this.db
      .prepare('SELECT body FROM tasks ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.body));
  }
  get(id) {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    return row ? JSON.parse(row.body) : null;
  }
  save(task, event) {
    task.updatedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    let entry;
    try {
      this.db
        .prepare(
          'INSERT INTO tasks(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(task.id, JSON.stringify(task));
      if (event) {
        entry = { taskId: task.id, at: task.updatedAt, ...event };
        const result = this.db
          .prepare('INSERT INTO events(task_id,body) VALUES (?,?)')
          .run(task.id, JSON.stringify(entry));
        entry.seq = Number(result.lastInsertRowid);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (entry) this.notify(entry);
    return task;
  }
  deleteTask(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM events WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.notify({ taskId: id, type: 'deleted' });
  }
  event(id, event) {
    const entry = { taskId: id, at: new Date().toISOString(), ...event };
    const result = this.db
      .prepare('INSERT INTO events(task_id,body) VALUES (?,?)')
      .run(id, JSON.stringify(entry));
    entry.seq = Number(result.lastInsertRowid);
    this.notify(entry);
    return entry;
  }
  notify(entry) {
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {}
    }
  }
  events(id, after = 0, limit = 1000) {
    return this.db
      .prepare('SELECT seq,body FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(id, after, limit)
      .map((r) => ({ ...JSON.parse(r.body), seq: Number(r.seq) }));
  }
  close() {
    this.db?.close();
    this.db = null;
    this.releaseLock();
  }
}
