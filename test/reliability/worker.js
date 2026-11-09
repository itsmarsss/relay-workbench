import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../../server/store.js';
import { Engine } from '../../server/engine.js';
import {
  DEFAULT_CONFIG,
  parseHandoff,
  validateHandoff,
  requireValue,
} from '../../server/domain.js';
import { demoHandoff } from '../../server/harness.js';
import { runProcess } from '../../server/process.js';
import { git } from '../../server/workspace.js';
import { PublicationWorkflow } from '../../server/publication-workflow.js';

const directory = process.argv[2];
const store = new Store(join(directory, 'state'));
const send = (value) => {
  if (process.connected) process.send(value);
};
const waiting = new Map();
async function checkpoint(input, phase = input.stage) {
  const id = randomUUID();
  send({
    type: 'checkpoint',
    id,
    stage: input.stage,
    phase,
    sessionId: input.sessionId,
    debug: !!input.task.debugContext,
    continuation: input.task.continuationContext,
    publicationContext: input.task.publicationContext,
  });
  return new Promise((resolve, reject) => {
    const abort = () => {
      waiting.delete(id);
      reject(new Error('Execution cancelled'));
    };
    if (input.signal.aborted) return abort();
    waiting.set(id, (mode) => {
      input.signal.removeEventListener('abort', abort);
      resolve(mode);
    });
    input.signal.addEventListener('abort', abort, { once: true });
  });
}
const engine = new Engine(store, {
  harness: async (input) => {
    input.onSession(input.sessionId || `reliability-${input.stage}`);
    if (input.stage === 'implement')
      await writeFile(join(input.task.workspace, 'value.txt'), 'after\n');
    const mode = await checkpoint(input);
    const handoff = {
      ...demoHandoff(input.task, input.stage),
      files: ['value.txt'],
      evidence: ['Scripted fixture provider; real workflow and temporary Git repository.'],
      risks: [],
    };
    const result = await runProcess(
      process.execPath,
      [fileURLToPath(new URL('./provider.js', import.meta.url)), mode],
      {
        cwd: input.task.workspace,
        input: JSON.stringify(handoff),
        signal: input.signal,
        timeout: mode === 'stall' ? 200 : 10000,
        onLine: (line) => {
          if (mode === 'hold') {
            const { providerPid } = JSON.parse(line);
            send({ type: 'provider-started', pid: providerPid });
          }
        },
        ...(mode === 'stall'
          ? { progressPolicy: { maxTimeout: 200, lastProgressAt: () => null } }
          : {}),
      },
    );
    requireValue(result.code === 0, `Fixture provider exited with ${result.code}`);
    return validateHandoff(parseHandoff(result.stdout), input.stage);
  },
});
const monitor = {
  running: new Map(),
  configure: (id, repositoryId, enabled) =>
    store.event(id, { type: 'fixture_monitor', repositoryId, enabled }),
};
const publication = new PublicationWorkflow(store, engine, monitor, {
  publish: async (input) => {
    const root = input.task.workspaceRoot;
    if (await git(root, ['status', '--porcelain'])) {
      await git(root, ['add', '--all']);
      await git(root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'fix: accepted fixture change',
      ]);
    }
    input.onSession('reliability-publication');
    await checkpoint(input, 'after-commit');
    return {
      verdict: 'complete',
      summary: 'Fixture publication complete',
      details: 'Local provider fixture observed the existing accepted commit.',
      evidence: ['Read temporary Git HEAD and accepted content'],
      files: ['value.txt'],
      risks: [],
      commit: await git(root, ['rev-parse', 'HEAD']),
      publication: {
        state: 'open',
        draft: true,
        url: 'https://code.example/fixture/pull/1',
        number: '1',
        title: 'Accepted fixture change',
        checks: 'pending',
        review: 'required',
      },
    };
  },
  validate: async () => {
    throw new Error('Unexpected publication reverification');
  },
});
let taskId = store.all()[0]?.id;
async function command(name, args) {
  if (name === 'initialize') {
    store.setConfig({
      ...DEFAULT_CONFIG,
      smartRouting: false,
      maxRecoveryAttempts: 1,
      maxRepairRounds: 1,
      harnesses: Object.fromEntries(
        Object.entries(DEFAULT_CONFIG.harnesses).map(([id, config]) => [
          id,
          { ...config, enabled: true, command: process.execPath },
        ]),
      ),
      repositories: [
        {
          id: 'fixture',
          name: 'Fixture',
          path: join(directory, 'repository'),
          cwd: '.',
          strategy: 'worktree',
          setup: [],
          checks: [
            {
              command: process.execPath,
              args: [
                '-e',
                "if(require('node:fs').readFileSync('value.txt','utf8')!=='after\\n')process.exit(1)",
              ],
            },
          ],
          instructions: '',
          verificationMode: 'commands',
        },
      ],
    });
    const task = engine.create({ title: 'Reliability fixture', repositoryId: 'fixture' });
    taskId = task.id;
    return task;
  }
  if (name === 'action') return engine.action(taskId, args.action, args.data);
  if (name === 'publish') return publication.start(taskId, 'fixture');
  if (name === 'release') {
    requireValue(waiting.has(args.id), 'Checkpoint no longer active');
    const resume = waiting.get(args.id);
    waiting.delete(args.id);
    resume(args.mode || 'complete');
    return true;
  }
  if (name === 'snapshot') {
    const task = store.get(taskId);
    const snapshot = {
      task,
      running: engine.running.has(taskId),
      publicationRunning: publication.running.has(taskId),
      reservations: [...engine.workspaceReservations.entries()],
      events: store.events(taskId, 0, 10000),
    };
    if (args.inspect && task.workspaceRoot) {
      snapshot.value = await readFile(join(task.workspace, 'value.txt'), 'utf8');
      snapshot.head = await git(task.workspaceRoot, ['rev-parse', 'HEAD']);
      snapshot.commitCount = Number(await git(task.workspaceRoot, ['rev-list', '--count', 'HEAD']));
    }
    return snapshot;
  }
  if (name === 'edit') {
    const task = store.get(taskId);
    await writeFile(join(task.workspace, 'value.txt'), args.value);
    return true;
  }
  if (name === 'shutdown') {
    await publication.stop();
    await engine.stop();
    store.close();
    return true;
  }
  throw new Error('Unknown fixture command');
}
process.on('message', async ({ id, name, args = {} }) => {
  try {
    const value = await command(name, args);
    send({ type: 'response', id, value });
    if (name === 'shutdown') process.disconnect();
  } catch (error) {
    send({ type: 'response', id, error: error.message });
  }
});
process.on('disconnect', () => {
  process.exit(0);
});
send({ type: 'ready' });
