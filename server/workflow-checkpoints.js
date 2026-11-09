import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { git, fingerprint, prepareWorkspace } from './workspace.js';
import { workspaces, workspaceView, syncPrimary } from './task-repositories.js';
import { newTask, requireValue } from './domain.js';

function records(store, key) {
  const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : [];
}
function put(store, key, value) {
  store.db
    .prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)')
    .run(key, JSON.stringify(value));
}
export function checkpoints(store, id) {
  return records(store, `checkpoints:${id}`).map(({ snapshot, ...record }) => record);
}
export function workflowHistory(store, id) {
  return {
    checkpoints: checkpoints(store, id),
    forks: records(store, `forks:${id}`),
    decisions: store.db
      .prepare(
        "SELECT body FROM events WHERE task_id=? AND json_extract(body, '$.type')='auto_decision' ORDER BY seq",
      )
      .all(id)
      .map((row) => JSON.parse(row.body)),
  };
}
export async function captureCheckpoint(store, task, attempt, { expectedFingerprint } = {}) {
  const key = `checkpoints:${task.id}`;
  if (records(store, key).some((c) => c.attemptId === attempt.id)) return;
  const before = task.demo ? null : (expectedFingerprint ?? (await fingerprint(task)));
  const id = randomUUID(),
    repositories = [],
    refs = [];
  const temp = join(store.directory, 'checkpoints', id);
  await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    const previous = records(store, key).at(-1);
    if (!task.demo && previous?.fingerprint === before) repositories.push(...previous.repositories);
    else if (!task.demo)
      for (const [i, entry] of workspaces(task).entries()) {
        const root = entry.workspaceRoot;
        requireValue(root, 'A checkpoint requires every task workspace');
        const head = await git(root, ['rev-parse', 'HEAD']);
        const indexPath = join(temp, `index-${i}`);
        const env = { GIT_INDEX_FILE: indexPath };
        const sourceIndex = await git(root, [
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          'index',
        ]);
        try {
          await copyFile(sourceIndex, indexPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await git(root, ['read-tree', head], { env });
        }
        const indexTree = await git(root, ['write-tree'], { env });
        await git(root, ['add', '-A', '--', '.'], { env });
        const workingTree = await git(root, ['write-tree'], { env });
        // Trees need their own refs: the HEAD commit alone does not retain dirty content.
        const repositoryRefs = [];
        const updates = [];
        for (const [name, object] of Object.entries({
          head,
          index: indexTree,
          work: workingTree,
        })) {
          const ref = `refs/relay/checkpoints/${task.id}/${id}/${i}/${name}`;
          updates.push(`update ${ref} ${object}`);
          repositoryRefs.push({ root, ref });
        }
        await git(root, ['update-ref', '--stdin'], {
          input: `start\n${updates.join('\n')}\nprepare\ncommit\n`,
        });
        refs.push(...repositoryRefs);
        repositories.push({
          repositoryId: entry.repository.id,
          root,
          head,
          indexTree,
          workingTree,
        });
      }
    requireValue(
      task.demo || previous?.fingerprint === before || before === (await fingerprint(task)),
      'Workspace changed while saving checkpoint',
    );
    const record = {
      id,
      attemptId: attempt.id,
      stage: attempt.stage,
      nextStage: task.stage,
      hasApproach: !!task.chosenApproach,
      at: new Date().toISOString(),
      summary: attempt.handoff.summary,
      fingerprint: before,
      repositories,
      snapshot: structuredClone(task),
    };
    put(store, key, [...records(store, key), record]);
    store.event(task.id, {
      type: 'checkpoint',
      attemptId: attempt.id,
      checkpointId: id,
      summary: `Checkpoint saved after ${attempt.stage}.`,
      details:
        'Committed, staged, unstaged and untracked files are preserved. Ignored files and external services are not captured.',
    });
    return record;
  } catch (error) {
    for (const { root, ref } of refs) await git(root, ['update-ref', '-d', ref]).catch(() => {});
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function forkCheckpoint(
  store,
  sourceId,
  checkpointId,
  { stage = 'saved', note = '' } = {},
) {
  requireValue(
    ['saved', 'plan', 'implement', 'verify'].includes(stage),
    'Choose a valid continuation stage',
  );
  requireValue(typeof note === 'string' && note.length <= 20000, 'Continuation note is too long');
  const record = records(store, `checkpoints:${sourceId}`).find((c) => c.id === checkpointId);
  requireValue(record, 'Checkpoint not found', 404);
  const source = record.snapshot;
  requireValue(
    stage !== 'implement' || source.chosenApproach,
    'Choose an approach before restarting implementation',
  );
  const config = { ...store.config, repositories: workspaces(source).map((e) => e.repository) };
  const task = newTask(
    {
      ...source,
      title: `${source.title.slice(0, 210)} · continuation`,
      repositoryId: source.demo ? undefined : source.repository.id,
      repositoryIds: source.demo ? [] : workspaces(source).map((e) => e.repository.id),
    },
    config,
  );
  const now = new Date().toISOString();
  task.attempts = source.attempts.map((a) => {
    // Carry the structured findings, never a native session tied to the old workspace.
    const {
      id,
      stage,
      status,
      harness,
      role,
      round,
      repositoryId,
      parentAttemptId,
      relation,
      startedAt,
      finishedAt,
      handoff,
      fingerprint: savedFingerprint,
    } = a;
    return {
      id,
      stage,
      status,
      harness,
      role,
      round,
      repositoryId,
      parentAttemptId,
      relation,
      startedAt,
      finishedAt,
      handoff,
      fingerprint: savedFingerprint,
      inherited: true,
    };
  });
  task.chosenApproach = source.chosenApproach;
  task.approvals = source.approvals
    .filter((a) => a.type === 'approach')
    .map(({ automation, ...approval }) => ({ ...approval, inherited: true }));
  task.reviewComments = structuredClone(source.reviewComments ?? []);
  task.messages = [
    ...structuredClone(source.messages ?? []),
    {
      role: 'user',
      at: now,
      text: `Continue from the saved ${record.stage} checkpoint. Earlier workspace paths and command results are historical context; inspect the current workspace and rerun verification.${note ? `\n\nDirection: ${note}` : ''}`,
    },
  ];
  task.fork = {
    sourceTaskId: sourceId,
    checkpointId,
    sourceAttemptId: record.attemptId,
    nodeId: `fork-${task.id}`,
    at: now,
  };
  task.stage = stage === 'saved' ? source.stage : stage;
  task.repositoryCursor = stage === 'saved' ? (source.repositoryCursor ?? 0) : 0;
  if (task.stage === 'review' || (source.status === 'awaiting_final' && stage === 'saved'))
    task.stage = 'verify';
  task.status = source.status === 'awaiting_plan' && stage === 'saved' ? 'awaiting_plan' : 'paused';
  // Completed investigations can be explored from planning; accepted results must be reverified.
  if (source.status === 'completed')
    task.stage = source.preset === 'investigate' ? 'investigate' : 'verify';
  task.checkpointRestore = { status: 'preparing' };
  store.save(task);
  try {
    for (const [i, entry] of workspaces(task).entries()) {
      if (task.demo) break;
      const saved = record.repositories.find((r) => r.repositoryId === entry.repository.id);
      requireValue(saved, 'Checkpoint is missing a repository');
      // An attached profile must never reset the user's checkout during rollback.
      if (entry.repository.strategy === 'attach') entry.repository.strategy = 'worktree';
      const view = workspaceView(task, entry);
      view.id = workspaces(task).length > 1 ? `${task.id}-${i}` : task.id;
      view.baseCommit = saved.head;
      await prepareWorkspace(view, store.directory, store.all());
      await git(view.workspaceRoot, ['read-tree', '--reset', '-u', saved.workingTree]);
      await git(view.workspaceRoot, ['read-tree', saved.indexTree]);
      for (const key of ['workspace', 'workspaceRoot', 'branch']) entry[key] = view[key];
      entry.baseCommit =
        workspaces(source).find((e) => e.repository.id === entry.repository.id).baseCommit ??
        saved.head;
      syncPrimary(task);
      store.save(task);
    }
    requireValue(
      task.demo || record.fingerprint === (await fingerprint(task)),
      'Restored workspace differs from checkpoint; inspect the saved continuation before running',
    );
    task.checkpointRestore.status = 'complete';
  } catch (error) {
    task.status = 'blocked';
    task.error = `Checkpoint restore failed: ${error.message}. Existing work has been preserved.`;
    task.checkpointRestore.status = 'failed';
    store.save(task, { type: 'blocked', summary: task.error });
    throw error;
  }
  task.reviewedFingerprint = null;
  task.verifiedFingerprint = null;
  store.save(task, {
    type: 'fork',
    summary: `Continued from ${record.stage} checkpoint. Verification and final acceptance will run again.`,
    sourceTaskId: sourceId,
    checkpointId,
  });
  put(store, `forks:${sourceId}`, [
    ...records(store, `forks:${sourceId}`),
    { taskId: task.id, checkpointId, attemptId: record.attemptId, at: now, stage: task.stage },
  ]);
  store.event(sourceId, {
    type: 'fork',
    summary: `Created a separate continuation from ${record.stage}.`,
    continuationTaskId: task.id,
    checkpointId,
  });
  return task;
}
