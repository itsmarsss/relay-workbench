import { FollowUpAgent } from './follow-up-agent.js';
import { currentTaskRun } from '../public/task-runs.js';
import { PublicationWorkflow } from './publication-workflow.js';
import { PublicationMonitor } from './publication-monitor.js';
import { listMemories, createMemory, updateMemory, deleteMemory } from './memory.js';
import { SideQuestions } from './side-questions.js';
import { importIssue } from './issues.js';
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
import { connectTerminal, writeTerminal, resizeTerminal } from './terminal-control.js';
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
  '.mjs': 'text/javascript',
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
export function taskListSummary(task) {
  const { attempts, approvals, messages, repository, deliveryRuns, ...rest } = task;
  const current = currentTaskRun(task);
  return {
    ...rest,
    repositories: workspaces(task).map((e) => ({
      repository: { id: e.repository.id, name: e.repository.name },
      delivery: e.delivery ? { status: e.delivery.status } : undefined,
      submission: e.submission ? { status: e.submission.status } : undefined,
    })),
    repository: { id: repository.id, name: repository.name },
    attemptCount: attempts.length,
    currentRun: current
      ? Object.fromEntries(
          ['id', 'stage', 'role', 'auxiliary', 'status', 'harness', 'startedAt'].map((key) => [
            key,
            current[key],
          ]),
        )
      : undefined,
    latestSummary: current?.summary ?? current?.handoff?.summary ?? '',
    totalDurationMs: attempts.reduce(
      (sum, a) => sum + (a.finishedAt ? new Date(a.finishedAt) - new Date(a.startedAt) : 0),
      0,
    ),
  };
}

export function createApp({ directory, publicDirectory, engineOptions = {} }) {
  const store = new Store(directory);
  const engine = new Engine(store, engineOptions);
  const publicationMonitor = new PublicationMonitor(store, {
    observe: engineOptions.publicationObserve ?? engineOptions.harness,
    isWorkspaceBusy: (root) => engine.workspaceReservations.has(root),
  });
  const publicationWorkflow = new PublicationWorkflow(store, engine, publicationMonitor, {
    publish: engineOptions.publicationPublish,
    validate: engineOptions.publicationValidate,
  });
  const sideQuestions = new SideQuestions(store, { answer: engineOptions.sideAnswer });
  const followUpAgent = new FollowUpAgent(store, engine, publicationMonitor, {
    run: engineOptions.followUpRun ?? engineOptions.harness,
  });
  const token = randomBytes(32).toString('hex');
  const streams = new Set();
  const terminalStreams = new Map();
  const external = new Map();
  const restorePreviews = new Map();
  let maintenance = false,
    mutations = 0;
  function requireIdle() {
    requireValue(
      engine.running.size === 0 &&
        engine.manualRuns.size === 0 &&
        external.size === 0 &&
        publicationMonitor.running.size === 0 &&
        publicationWorkflow.running.size === 0 &&
        sideQuestions.running.size === 0 &&
        followUpAgent.running.size === 0 &&
        !store.all().some((t) => ['running', 'queued', 'manual'].includes(t.status)),
      'Pause active workflows and submissions before maintenance',
      409,
    );
  }
  async function exclusive(operation) {
    requireValue(!maintenance && mutations === 1, 'Wait for other writes before maintenance', 409);
    requireIdle();
    maintenance = true;
    publicationMonitor.suspended = true;
    try {
      return await operation();
    } finally {
      maintenance = false;
      publicationMonitor.suspended = false;
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const styleNonce = randomBytes(18).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
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
      if (path === '/api/memories' && req.method === 'GET')
        return json(res, 200, listMemories(store));
      if (path === '/api/memories' && req.method === 'POST') {
        const raw = await body(req);
        requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid memory');
        requireValue(
          Object.keys(raw).every((key) =>
            [
              'scope',
              'targetId',
              'kind',
              'status',
              'title',
              'content',
              'evidence',
              'expiresAt',
            ].includes(key),
          ),
          'Unknown memory field',
        );
        return json(res, 201, createMemory(store, raw));
      }
      const memoryId = path.match(/^\/api\/memories\/([a-f0-9-]{36})$/)?.[1];
      if (memoryId && req.method === 'PATCH')
        return json(res, 200, updateMemory(store, memoryId, await body(req)));
      if (memoryId && req.method === 'DELETE') {
        deleteMemory(store, memoryId, (await body(req))?.revision);
        return json(res, 200, { deleted: true });
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
        return json(res, 200, {
          ok: true,
          running:
            followUpAgent.running.size +
            engine.running.size +
            publicationMonitor.running.size +
            publicationWorkflow.running.size,
          monitoring: publicationMonitor.running.size,
          version: '0.1.0',
        });
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
        return json(res, 200, await importIssue(repository.issueCommand, ticket, info.cwd));
      }
      if (path === '/api/outcomes' && req.method === 'GET')
        return json(
          res,
          200,
          routingOutcomes(store.all(), store.config, url.searchParams.get('repositoryId') || ''),
        );
      if (path === '/api/tasks' && req.method === 'GET')
        return json(res, 200, store.all().map(taskListSummary));
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
          if (
            !res.write(
              `${Number.isSafeInteger(event.seq) ? `id: ${event.seq}\n` : ''}data: ${data}\n\n`,
            )
          )
            res.end();
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
        if (operation === 'status-override' && req.method === 'POST') {
          const request = await body(req);
          requireValue(
            request.value === null ||
              ['draft', 'running', 'review', 'completed', 'blocked', 'cancelled'].includes(
                request.value,
              ),
            'Choose a valid task status',
          );
          const current = store.get(id);
          current.statusOverride =
            request.value === null ? null : { value: request.value, at: new Date().toISOString() };
          store.save(current, {
            type: 'status_override',
            summary: request.value
              ? `Task status overridden to ${request.value}. Automation is unchanged.`
              : 'Task status now follows the workflow.',
          });
          return json(res, 200, current);
        }
        if (operation === 'publish-stop' && req.method === 'POST')
          return json(res, 202, publicationWorkflow.pause(id));
        if (operation === 'publish' && req.method === 'POST') {
          requireValue(
            ![...external.keys()].some((key) => key.startsWith(`${id}:`)),
            'Publication is already running',
            409,
          );
          const request = await body(req);
          return json(
            res,
            202,
            await publicationWorkflow.start(id, request.repositoryId ?? task.repository.id),
          );
        }
        if (operation === 'publication' && req.method === 'POST') {
          const request = await body(req);
          requireValue(
            !publicationWorkflow.running.has(id) && !followUpAgent.running.has(id),
            'Wait for the active agent to finish before changing monitoring',
            409,
          );
          requireValue(
            typeof request.enabled === 'boolean',
            'Choose whether monitoring is enabled',
          );
          return json(
            res,
            202,
            publicationMonitor.configure(
              id,
              request.repositoryId ?? task.repository.id,
              request.enabled,
            ),
          );
        }
        if (operation === 'follow-up' && req.method === 'POST') {
          const request = await body(req);
          requireValue(
            ['auto', 'question', 'changes', 'publication'].includes(request.mode ?? 'auto'),
            'Choose a follow-up mode',
          );
          if (request.mode === 'question')
            return json(res, 202, sideQuestions.ask(id, request.message));
          requireValue(
            !publicationWorkflow.running.has(id) &&
              !followUpAgent.running.has(id) &&
              ![...external.keys()].some((key) => key.startsWith(`${id}:`)),
            'Wait for publication to finish',
            409,
          );
          if (!request.mode || request.mode === 'auto')
            return json(res, 202, await followUpAgent.start(id, request));
          if (request.mode === 'publication')
            return json(
              res,
              202,
              await publicationWorkflow.start(id, request.repositoryId ?? task.repository.id, {
                request: request.message,
              }),
            );
          return json(res, 202, await engine.action(id, 'follow-up', request));
        }
        if (operation === 'follow-up-stop' && req.method === 'POST') {
          await followUpAgent.pause(id);
          return json(res, 200, { stopped: true });
        }
        if (operation === 'sync-base' && req.method === 'POST')
          return json(res, 200, await engine.action(id, 'sync-base', await body(req)));
        if (operation === 'question' && req.method === 'POST')
          return json(res, 202, sideQuestions.ask(id, (await body(req)).question));
        if (!operation && req.method === 'GET')
          return json(res, 200, {
            ...task,
            executionActive:
              engine.running.has(id) || engine.manualRuns.has(id) || followUpAgent.running.has(id),
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
        if (['terminal-stream', 'terminal-input'].includes(operation)) {
          const session = url.searchParams.get('session');
          requireValue(
            task.status === 'manual' && task.manual?.active,
            'Take over this task before using the terminal',
            409,
          );
          requireValue(
            session === task.manual.session,
            'This terminal session has changed. Reconnect before typing.',
            409,
          );
          const terminal = task.manual;
          if (operation === 'terminal-input' && req.method === 'POST') {
            const data = await body(req);
            const current = store.get(id);
            requireValue(
              current?.status === 'manual' &&
                current.manual?.active &&
                current.manual.session === session,
              'Terminal control has ended',
              409,
            );
            if (data.type === 'input') {
              requireValue(
                typeof data.data === 'string' &&
                  Buffer.byteLength(data.data) > 0 &&
                  Buffer.byteLength(data.data) <= 8192,
                'Terminal input must be 1–8192 bytes',
              );
              await writeTerminal(terminal, data.data);
            } else if (data.type === 'resize') {
              requireValue(
                Number.isInteger(data.cols) &&
                  data.cols >= 20 &&
                  data.cols <= 500 &&
                  Number.isInteger(data.rows) &&
                  data.rows >= 5 &&
                  data.rows <= 200,
                'Invalid terminal dimensions',
              );
              await resizeTerminal(terminal, data.cols, data.rows);
            } else throw new InputError('Invalid terminal input type');
            return json(res, 200, { ok: true });
          }
          requireValue(
            operation === 'terminal-stream' && req.method === 'GET',
            'Unsupported terminal operation',
            405,
          );
          requireValue((terminalStreams.get(id)?.size ?? 0) < 3, 'Too many terminal viewers', 429);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
          const viewers = terminalStreams.get(id) ?? new Set();
          terminalStreams.set(id, viewers);
          let disconnect,
            stopped = false;
          const stop = () => {
            if (stopped) return;
            stopped = true;
            disconnect?.();
            clearInterval(heartbeat);
            store.listeners.delete(check);
            viewers.delete(stop);
            streams.delete(res);
            if (!viewers.size) terminalStreams.delete(id);
            if (!res.writableEnded && !res.destroyed)
              res.write(
                `data: ${JSON.stringify({ type: 'closed', message: 'Terminal control has ended.' })}\n\n`,
              );
            res.end();
          };
          const check = () => {
            const current = store.get(id);
            if (
              current?.status !== 'manual' ||
              !current.manual?.active ||
              current.manual.session !== terminal.session
            )
              stop();
          };
          const heartbeat = setInterval(() => {
            check();
            if (!res.writableEnded) res.write(': heartbeat\n\n');
          }, 10000);
          heartbeat.unref();
          viewers.add(stop);
          streams.add(res);
          store.listeners.add(check);
          disconnect = connectTerminal(
            terminal,
            (event) => {
              if (res.writableLength > 1024 * 1024) return stop();
              if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
            },
            stop,
          );
          res.on('close', stop);
          return;
        }
        if (operation === 'terminal-preview' && req.method === 'GET') {
          const attemptId = url.searchParams.get('attemptId');
          requireValue(
            typeof attemptId === 'string' && attemptId.length <= 100,
            'Select a terminal',
          );
          const attempt = task.attempts.find((a) => a.id === attemptId);
          const delivery = workspaces(task)
            .flatMap((e) => [e.delivery, e.publicationMonitor])
            .find((a) => a && (a.id ?? a.attemptId) === attemptId);
          const terminal =
            attemptId === 'manual'
              ? task.status === 'manual' && task.manual?.active && task.manual
              : delivery?.status === 'running'
                ? delivery.terminal
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
          requireValue(
            request.mode === undefined || ['agent', 'commands'].includes(request.mode),
            'Choose agent or commands publication mode',
          );
          if (request.mode !== 'commands') {
            requireValue(
              ![...external.keys()].some((key) => key.startsWith(`${id}:`)),
              'Publication is already running',
              409,
            );
            return json(
              res,
              202,
              await publicationWorkflow.start(id, request.repositoryId ?? task.repository.id),
            );
          }

          const entry = workspaces(task).find(
            (e) => e.repository.id === (request.repositoryId ?? task.repository.id),
          );
          requireValue(entry, 'Select a task repository');
          const target = workspaceView(task, entry);
          requireValue(
            !publicationWorkflow.running.has(id) && !followUpAgent.running.has(id),
            'Another agent is already running',
            409,
          );
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
                    ? 'Provider submission completed. A status agent will locate the PR and observe checks and review.'
                    : 'Provider command failed. Inspect its full output before retrying.',
                details: result.stdout + '\n' + result.stderr,
              });
              publicationMonitor.configure(id, entry.repository.id, true);
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
              publicationMonitor.tick();
            });
          return json(res, 202, task);
        }
        if (
          req.method === 'POST' &&
          [
            'start',
            'debug',
            'resolve-blocker',
            'verify-blocker',
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
        ) {
          requireValue(
            !publicationWorkflow.running.has(id) && !followUpAgent.running.has(id),
            'Stop the active agent before changing the development workflow',
            409,
          );
          return json(res, 200, await engine.action(id, operation, await body(req)));
        }
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
      if (filename === 'index.html')
        bytes = Buffer.from(
          bytes
            .toString()
            .replace('<head>', `<head><meta name="relay-style-nonce" content="${styleNonce}">`),
        );
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
    await followUpAgent.stop();
    await publicationWorkflow.stop();
    await publicationMonitor.stop();
    await sideQuestions.stop();
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
