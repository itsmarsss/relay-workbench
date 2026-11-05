import { createBackup, previewBackup, restoreBackup, backupPath } from './backups.js';
import { lifecycleReport, cleanupWorktree } from './lifecycle.js';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { routingOutcomes } from './outcomes.js';
import { snapshotDiff } from './review-comments.js';
import { inbox, acknowledge } from './inbox.js';
import { uploadImage, readImage } from './attachments.js';
import http from 'node:http';
import { captureTerminal } from './terminal.js';
import { workspaces, workspaceView } from './task-repositories.js';
import { readFile, realpath, rm, lstat } from 'node:fs/promises';
import { resolve, extname, relative, isAbsolute } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { InputError, requireValue, text } from './domain.js';
import { decodeEvent } from './harness.js';
import { executableExists, runProcess } from './process.js';
import { diff, fingerprint, inspectRepository, git } from './workspace.js';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    requireValue(Buffer.byteLength(content) < 1024 * 1024, 'Request body too large', 413);
  }
  try {
    return JSON.parse(content || '{}');
  } catch {
    throw new InputError('Invalid JSON request body');
  }
}
function summary(task) {
  const { attempts, approvals, messages, repository, ...rest } = task;
  return {
    ...rest,
    repositories: workspaces(task).map((e) => ({
      repository: { id: e.repository.id, name: e.repository.name },
    })),
    repository: { id: repository.id, name: repository.name },
    attemptCount: attempts.length,
    latestSummary: attempts.findLast((a) => a.handoff)?.handoff.summary ?? '',
    totalDurationMs: attempts.reduce(
      (sum, a) => sum + (a.finishedAt ? new Date(a.finishedAt) - new Date(a.startedAt) : 0),
      0,
    ),
  };
}

export function createApp({ directory, publicDirectory, engineOptions = {} }) {
  const store = new Store(directory);
  const engine = new Engine(store, engineOptions);
  const token = randomBytes(32).toString('hex');
  const streams = new Set();
  const external = new Map();
  const restorePreviews = new Map();
  let maintenance = false,
    mutations = 0;
  function requireIdle() {
    requireValue(
      engine.running.size === 0 &&
        engine.manualRuns.size === 0 &&
        external.size === 0 &&
        !store.all().some((t) => ['running', 'queued', 'manual'].includes(t.status)),
      'Pause active workflows and submissions before maintenance',
      409,
    );
  }
  async function exclusive(operation) {
    requireValue(!maintenance && mutations === 1, 'Wait for other writes before maintenance', 409);
    requireIdle();
    maintenance = true;
    try {
      return await operation();
    } finally {
      maintenance = false;
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const expected = `127.0.0.1:${server.address().port}`;
      requireValue(req.headers.host === expected, 'Invalid local host', 403);
      const origin = `http://${expected}`;
      requireValue(
        !req.headers.origin || req.headers.origin === origin,
        'Cross-origin request rejected',
        403,
      );
      requireValue(
        req.headers['sec-fetch-site'] !== 'cross-site',
        'Cross-site request rejected',
        403,
      );
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) {
        requireValue(!maintenance, 'Maintenance in progress; retry shortly', 409);
        mutations++;
        req.relayMutation = true;
        const supplied = req.headers['x-relay-token'];
        requireValue(
          typeof supplied === 'string' &&
            /^[a-f0-9]{64}$/.test(supplied) &&
            timingSafeEqual(Buffer.from(supplied), Buffer.from(token)),
          'Session token required',
          403,
        );
        requireValue(
          (path === '/api/attachments' && req.method === 'POST') ||
            (path === '/api/backups/preview' &&
              req.method === 'POST' &&
              req.headers['content-type'] === 'application/gzip') ||
            req.headers['content-type']?.startsWith('application/json'),
          'JSON content type required',
          415,
        );
      }
      if (path === '/api/storage' && req.method === 'GET')
        return json(res, 200, await lifecycleReport(store));
      if (path === '/api/storage/cleanup' && req.method === 'POST') {
        const data = await body(req);
        return json(res, 200, await exclusive(() => cleanupWorktree(store, data)));
      }
      if (path === '/api/backups' && req.method === 'POST')
        return json(res, 201, await exclusive(() => createBackup(store)));
      if (path === '/api/backups/preview' && req.method === 'POST') {
        requireValue(
          req.headers['content-type'] === 'application/gzip',
          'Upload a .relay.gz backup',
          415,
        );
        requireValue(
          restorePreviews.size < 3,
          'Close an existing restore preview before uploading another',
          409,
        );
        let preview;
        try {
          preview = await previewBackup(req, directory);
        } catch (error) {
          throw new InputError(`Invalid backup: ${error.message}`, error.status || 400);
        }
        preview.timer = setTimeout(
          () => {
            restorePreviews.delete(preview.id);
            rm(preview.directory, { recursive: true, force: true }).catch(() => {});
          },
          15 * 60 * 1000,
        );
        preview.timer.unref();
        restorePreviews.set(preview.id, preview);
        return json(res, 200, { id: preview.id, ...preview.summary });
      }
      if (path === '/api/backups/discard' && req.method === 'POST') {
        const preview = restorePreviews.get((await body(req)).previewId);
        if (preview) {
          clearTimeout(preview.timer);
          restorePreviews.delete(preview.id);
          await rm(preview.directory, { recursive: true, force: true });
        }
        return json(res, 200, { ok: true });
      }
      if (path === '/api/backups/restore' && req.method === 'POST') {
        const data = await body(req),
          preview = restorePreviews.get(data.previewId);
        requireValue(preview, 'Restore preview expired; upload again', 409);
        requireValue(data.confirm === true, 'Confirm replacement after reviewing the backup', 409);
        return json(
          res,
          200,
          await exclusive(async () => {
            const safetyBackup = await createBackup(store);
            clearTimeout(preview.timer);
            restorePreviews.delete(preview.id);
            const restored = await restoreBackup(store, preview);
            engine.workspaceReservations.clear();
            for (const task of store.all())
              for (const entry of workspaces(task))
                if (
                  entry.repository.strategy === 'attach' &&
                  entry.workspaceRoot &&
                  !['completed', 'cancelled'].includes(task.status)
                )
                  engine.workspaceReservations.set(entry.workspaceRoot, task.id);
            store.notify({ seq: 0, taskId: '', type: 'restored' });
            return { ...restored, safetyBackup };
          }),
        );
      }
      const archive = path.match(/^\/api\/backups\/([a-f0-9-]{36})$/);
      if (archive && req.method === 'GET') {
        const file = backupPath(directory, archive[1]);
        let stat;
        try {
          stat = await lstat(file);
        } catch (error) {
          if (error.code === 'ENOENT') throw new InputError('Backup not found', 404);
          throw error;
        }
        requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Invalid backup file', 403);
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${archive[1]}.relay.gz"`,
        });
        await pipeline(createReadStream(file), res);
        return;
      }
      if (path === '/api/attachments' && req.method === 'POST')
        return json(res, 201, await uploadImage(req, directory));
      if (path.startsWith('/api/attachments/') && ['GET', 'HEAD'].includes(req.method)) {
        const image = await readImage(path, directory);
        res.writeHead(200, {
          'Content-Type': image.type,
          'Content-Length': image.size,
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        return res.end(req.method === 'HEAD' ? undefined : image.bytes);
      }
      if (path === '/api/bootstrap' && req.method === 'GET')
        return json(res, 200, { token, config: store.config, version: '0.1.0' });
      if (path === '/api/inbox' && req.method === 'GET') return json(res, 200, inbox(store));
      if (path === '/api/inbox/seen' && req.method === 'POST') {
        requireValue(
          acknowledge(store, (await body(req)).key),
          'Attention item changed; refresh the inbox',
          409,
        );
        return json(res, 200, { ok: true });
      }
      if (path === '/api/health' && req.method === 'GET')
        return json(res, 200, { ok: true, running: engine.running.size, version: '0.1.0' });
      if (path === '/api/harnesses' && req.method === 'GET') {
        const harnesses = await Promise.all(
          Object.entries(store.config.harnesses).map(async ([id, config]) => ({
            id,
            ...config,
            available: await executableExists(config.command),
          })),
        );
        return json(res, 200, harnesses);
      }
      if (path === '/api/config' && req.method === 'PUT') {
        requireValue(
          engine.running.size === 0 && external.size === 0,
          'Pause active executions before changing configuration',
          409,
        );
        const config = store.setConfig(await body(req));
        return json(res, 200, config);
      }
      if (path === '/api/repositories/inspect' && req.method === 'POST') {
        const raw = await body(req);
        return json(
          res,
          200,
          await inspectRepository({
            path: text(raw.path, 'Path', 2000),
            cwd: text(raw.cwd ?? '.', 'Working subdirectory', 2000),
          }),
        );
      }
      if (path === '/api/tickets/import' && req.method === 'POST') {
        const raw = await body(req);
        const repository = store.config.repositories.find((r) => r.id === raw.repositoryId);
        requireValue(
          repository?.issueCommand,
          'Configure an issue import command for this repository',
        );
        const ticket = text(raw.ticket, 'Ticket', 2000);
        requireValue(
          /^\d+$/.test(ticket) || /^https:\/\/[^\s]+$/.test(ticket),
          'Use an issue number or HTTPS issue URL',
        );
        const info = await inspectRepository(repository);
        const cmd = repository.issueCommand;
        const result = await runProcess(
          cmd.command,
          cmd.args.map((a) => a.replaceAll('{ticket}', ticket)),
          { cwd: info.cwd, timeout: 60000 },
        );
        requireValue(result.code === 0, `Issue import failed: ${result.stderr.slice(-2000)}`, 502);
        let issue;
        try {
          issue = JSON.parse(result.stdout);
        } catch {
          throw new InputError('Issue command must return JSON with title and body fields', 502);
        }
        return json(res, 200, {
          title: text(issue.title, 'Issue title', 240),
          description: text(issue.body ?? issue.description ?? '', 'Issue body', 50000, true),
          ticket: typeof issue.url === 'string' ? issue.url : ticket,
        });
      }
      if (path === '/api/outcomes' && req.method === 'GET')
        return json(
          res,
          200,
          routingOutcomes(store.all(), store.config, url.searchParams.get('repositoryId') || ''),
        );
      if (path === '/api/tasks' && req.method === 'GET')
        return json(res, 200, store.all().map(summary));
      if (path === '/api/tasks' && req.method === 'POST')
        return json(res, 201, engine.create(await body(req)));
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        streams.add(res);
        const listener = (event) => {
          if (event.type === 'transcript') return;
          const data = JSON.stringify({ seq: event.seq, taskId: event.taskId, type: event.type });
          if (!res.write(`id: ${event.seq}\ndata: ${data}\n\n`)) res.end();
        };
        store.listeners.add(listener);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          store.listeners.delete(listener);
          streams.delete(res);
        });
        return;
      }
      const match = path.match(/^\/api\/tasks\/([a-f0-9-]+)(?:\/([a-z-]+))?$/);
      if (match) {
        const [, id, operation] = match;
        const task = store.get(id);
        requireValue(task, 'Task not found', 404);
        if (!operation && req.method === 'GET')
          return json(res, 200, {
            ...task,
            executionActive: engine.running.has(id) || engine.manualRuns.has(id),
            canSteer:
              engine.controls.has(id) ||
              (task.status === 'running' &&
                task.attempts.findLast((a) => a.status === 'running')?.harness === 'claude' &&
                !!task.attempts.findLast((a) => a.status === 'running')?.sessionId),
          });
        if (!operation && req.method === 'PATCH')
          return json(res, 200, engine.update(id, await body(req)));
        if (operation === 'events' && req.method === 'GET') {
          const after = Number(url.searchParams.get('after') || 0);
          requireValue(Number.isSafeInteger(after) && after >= 0, 'Invalid event cursor');
          return json(
            res,
            200,
            store.events(id, after).map((event) => {
              if (event.type !== 'transcript' || event.stream !== 'stdout' || !event.harness)
                return event;
              const decoded = decodeEvent(event.harness, event.text);
              const messages = (decoded.activities ?? [decoded])
                .filter((a) => a.kind === 'message')
                .map((a) => a.details || a.activity);
              return messages.length ? { ...event, agentMessages: messages } : event;
            }),
          );
        }
        if (operation === 'terminal-preview' && req.method === 'GET') {
          const attemptId = url.searchParams.get('attemptId');
          requireValue(
            typeof attemptId === 'string' && attemptId.length <= 100,
            'Select a terminal',
          );
          const attempt = task.attempts.find((a) => a.id === attemptId);
          const terminal =
            attemptId === 'manual'
              ? task.status === 'manual' && task.manual?.active && task.manual
              : task.status === 'running' && attempt?.status === 'running' && attempt.terminal;
          if (!terminal)
            return json(res, 200, {
              available: false,
              output: '',
              message:
                'No live terminal for this selection. Retained output remains in the activity thread.',
            });
          return json(res, 200, await captureTerminal(terminal));
        }
        if (operation === 'diff' && req.method === 'GET')
          return json(res, 200, await snapshotDiff(task));
        if (operation === 'export' && req.method === 'GET') {
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="relay-${id.slice(0, 8)}.json"`,
          );
          return json(res, 200, { task, events: store.events(id, 0, 100000) });
        }
        if (operation === 'submit' && req.method === 'POST') {
          requireValue(
            task.status === 'completed' && !task.demo,
            'Accept a live task before submitting a PR',
            409,
          );
          const request = await body(req);
          const entry = workspaces(task).find(
            (e) => e.repository.id === (request.repositoryId ?? task.repository.id),
          );
          requireValue(entry, 'Select a task repository');
          const target = workspaceView(task, entry);
          const submissionKey = `${id}:${entry.repository.id}`;
          const saveSubmission = (update) => {
            const current = store.get(id);
            const currentEntry = workspaces(current).find(
              (e) => e.repository.id === entry.repository.id,
            );
            currentEntry.submission = { ...currentEntry.submission, ...update };
            return current;
          };
          requireValue(target.repository.prCommand, 'No PR command configured for this repository');
          requireValue(
            ![...external.keys()].some((key) => key.startsWith(`${id}:`)) && !entry.submission,
            'PR submission already exists or is running',
            409,
          );
          const owner = engine.workspaceReservations.get(target.workspaceRoot);
          requireValue(!owner || owner === id, 'This workspace is reserved by another task', 409);
          requireValue(
            (await fingerprint(target)) === (entry.acceptedFingerprint ?? task.reviewedFingerprint),
            'Workspace changed since acceptance; inspect it before submitting',
            409,
          );
          requireValue(
            ![...external.keys()].some((key) => key.startsWith(`${id}:`)) &&
              !workspaces(store.get(id)).find((e) => e.repository.id === entry.repository.id)
                .submission,
            'Another submission started; refresh before continuing',
            409,
          );
          requireValue(
            !engine.workspaceReservations.has(target.workspaceRoot) ||
              engine.workspaceReservations.get(target.workspaceRoot) === id,
            'Workspace was reserved by another task',
            409,
          );
          engine.workspaceReservations.set(target.workspaceRoot, id);
          const controller = new AbortController();
          external.set(submissionKey, controller);
          entry.submission = { status: 'running', startedAt: new Date().toISOString() };
          store.save(saveSubmission(entry.submission), {
            type: 'submission',
            summary: `Submitting ${entry.repository.name} through its configured provider.`,
          });
          const cmd = target.repository.prCommand;
          (async () => {
            const log = (line, stream) =>
              store.event(id, {
                type: 'transcript',
                stage: 'submission',
                repositoryId: entry.repository.id,
                stream,
                text: line,
              });
            const dirty = await git(target.workspaceRoot, [
              'status',
              '--porcelain',
              '--untracked-files=normal',
            ]);
            if (dirty) {
              requireValue(
                (await fingerprint(target)) ===
                  (entry.acceptedFingerprint ?? task.reviewedFingerprint),
                'Workspace changed before committing',
              );
              await git(target.workspaceRoot, ['add', '--all'], {
                signal: controller.signal,
                onLine: log,
              });
              const expectedTree = await git(target.workspaceRoot, ['write-tree']);
              const commitSubject = `feat: ${task.title.replace(/[\r\n]/g, ' ').trim()}`.slice(
                0,
                59,
              );
              await git(target.workspaceRoot, ['commit', '-m', commitSubject], {
                signal: controller.signal,
                onLine: log,
              });
              requireValue(
                (await git(target.workspaceRoot, ['rev-parse', 'HEAD^{tree}'])) === expectedTree &&
                  !(await git(target.workspaceRoot, [
                    'status',
                    '--porcelain',
                    '--untracked-files=normal',
                  ])),
                'Commit hooks changed the accepted workspace. Inspect and reverify it before submitting.',
              );
              const current = saveSubmission({
                commit: await git(target.workspaceRoot, ['rev-parse', 'HEAD']),
              });
              store.save(current, {
                type: 'submission',
                summary: `Accepted changes committed: ${commitSubject}`,
              });
            }
            return runProcess(cmd.command, cmd.args, {
              cwd: target.workspace,
              signal: controller.signal,
              timeout: 600000,
              onLine: log,
            });
          })()
            .then((result) => {
              const current = saveSubmission({
                status: result.code === 0 ? 'complete' : 'failed',
                ...result,
                finishedAt: new Date().toISOString(),
              });
              store.save(current, {
                type: 'submission',
                summary:
                  result.code === 0
                    ? 'Provider command completed. Inspect its full output.'
                    : 'Provider command failed. Inspect its full output before retrying.',
                details: result.stdout + '\n' + result.stderr,
              });
            })
            .catch((error) => {
              const current = saveSubmission({
                status: 'failed',
                error: error.message,
              });
              store.save(current, { type: 'submission', summary: error.message });
            })
            .finally(() => {
              external.delete(submissionKey);
              if (engine.workspaceReservations.get(target.workspaceRoot) === id)
                engine.workspaceReservations.delete(target.workspaceRoot);
            });
          return json(res, 202, task);
        }
        if (
          req.method === 'POST' &&
          [
            'start',
            'resume',
            'approve-plan',
            'request-changes',
            'accept',
            'pause',
            'cancel',
            'message',
            'steer',
            'review-comment',
            'resolve-comment',
            'takeover',
            'return-control',
          ].includes(operation)
        )
          return json(res, 200, await engine.action(id, operation, await body(req)));
      }
      if (path.startsWith('/api/')) throw new InputError('Endpoint not found', 404);
      requireValue(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed', 405);
      const filename = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const file = resolve(publicDirectory, filename);
      const rel = relative(publicDirectory, file);
      requireValue(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'Invalid path', 403);
      let bytes;
      try {
        const actual = await realpath(file);
        requireValue(actual.startsWith(publicDirectory + '/'), 'Invalid asset', 403);
        bytes = await readFile(actual);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR')
          throw new InputError('Asset not found', 404);
        throw error;
      }
      res.writeHead(200, {
        'Content-Type': `${TYPES[extname(file)] || 'application/octet-stream'}; charset=utf-8`,
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error.status || 500;
      json(res, status, { error: error.message || 'Unexpected server error' });
    } finally {
      if (req.relayMutation) mutations--;
    }
  });
  async function close() {
    for (const preview of restorePreviews.values()) {
      clearTimeout(preview.timer);
      await rm(preview.directory, { recursive: true, force: true });
    }
    restorePreviews.clear();
    for (const stream of streams) stream.end();
    for (const controller of external.values()) controller.abort();
    await engine.stop();
    while (external.size) await new Promise((resolve) => setTimeout(resolve, 20));
    if (server.listening)
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
    store.close();
  }
  return { server, store, engine, close };
}
