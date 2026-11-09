import { completedPlan } from '../public/workflow-plan.js';
import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { git, fingerprint, prepareWorkspace } from './workspace.js';
import { workspaces, workspaceView, syncPrimary } from './task-repositories.js';
import { newTask, requireValue } from './domain.js';
import { blockerDecision } from './recovery.js';

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
  return records(store, `checkpoints:${id}`).map(({ snapshot, ...record }) => ({
    ...record,
    approaches: record.approaches ?? completedPlan(snapshot)?.options ?? [],
    canChooseDebug:
      record.canChooseDebug ??
      (record.role === 'debug' || !!snapshot.blockerDecision || !!snapshot.recovery?.active),
    investigationOnly: snapshot.preset === 'investigate',
  }));
}
export function workflowHistory(store, id) {
  const forks = records(store, `forks:${id}`);
  const byTask = new Map(forks.map((fork) => [fork.taskId, fork]));
  // A crash or older Relay version may have saved the continuation without its
  // corresponding history entry. Reconstruct it without changing either task.
  const continuations = store.db
    .prepare("SELECT body FROM tasks WHERE json_extract(body, '$.fork.sourceTaskId')=?")
    .all(id);
  for (const { body } of continuations) {
    const task = JSON.parse(body);
    const fork = byTask.get(task.id);
    const status = task.checkpointRestore?.status;
    if (fork) {
      if (status === 'failed' || status === 'preparing') fork.status = status;
    } else {
      const entry = {
        taskId: task.id,
        checkpointId: task.fork.checkpointId,
        attemptId: task.fork.sourceAttemptId,
        at: task.fork.at,
        stage: task.stage,
        mode: task.fork.mode,
        ...(status ? { status } : {}),
      };
      forks.push(entry);
      byTask.set(task.id, entry);
    }
  }
  return {
    checkpoints: checkpoints(store, id),
    forks,
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
      role: attempt.role,
      verdict: attempt.handoff.verdict,
      approaches: completedPlan(task)?.options ?? [],
      canChooseDebug: attempt.role === 'debug' || !!task.blockerDecision || !!task.recovery?.active,
      selectedApproachId: task.chosenApproach?.id ?? null,
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
    ['saved', 'approach', 'decision', 'plan', 'implement', 'verify'].includes(stage),
    'Choose a valid continuation stage',
  );
  requireValue(typeof note === 'string' && note.length <= 20000, 'Continuation note is too long');
  const record = records(store, `checkpoints:${sourceId}`).find((c) => c.id === checkpointId);
  requireValue(record, 'Checkpoint not found', 404);
  const source = record.snapshot;
  const plan = completedPlan(source);
  requireValue(
    stage !== 'approach' || plan?.options?.length,
    'This checkpoint has no saved implementation choices',
  );
  requireValue(
    stage !== 'decision' || record.canChooseDebug || source.recovery || source.blockerDecision,
    'This checkpoint has no debugger decision',
  );

  requireValue(
    !['implement', 'verify'].includes(stage) || source.chosenApproach,
    'Choose an approach before implementation or verification',
  );
  requireValue(
    source.preset !== 'investigate' || ['saved', 'decision'].includes(stage),
    'Change the investigation-only preset before planning implementation',
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
      followUpId,
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
      followUpId,
      parentAttemptId,
      relation,
      startedAt,
      finishedAt,
      handoff,
      fingerprint: savedFingerprint,
      inherited: true,
      originTaskId: a.originTaskId ?? sourceId,
    };
  });
  task.followUpContext = structuredClone(source.followUpContext ?? null);
  task.followUps = structuredClone(source.followUps ?? []);
  task.loopGuardAcknowledgedAt = task.attempts.length;
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
      text: `Continue from the saved ${record.stage} checkpoint. Earlier workspace paths and command results are historical context; inspect the current workspace and rerun verification.${stage === 'approach' ? ' Reopen the saved proposal for a new choice. Revise any earlier implementation to the newly approved approach while preserving unrelated work.' : stage === 'decision' ? ' Reconsider the saved diagnosis using the new debugger choice; earlier choices are historical context, not instructions to repeat them.' : ''}${note ? `\n\nDirection: ${note}` : ''}`,
    },
  ];
  task.fork = {
    sourceTaskId: sourceId,
    checkpointId,
    sourceAttemptId: record.attemptId,
    nodeId: `fork-${task.id}`,
    at: now,
    mode: stage,
  };
  const restoringFlow = ['saved', 'decision'].includes(stage);
  task.stage = restoringFlow ? source.stage : stage === 'approach' ? 'plan' : stage;
  task.repositoryCursor = restoringFlow ? (source.repositoryCursor ?? 0) : 0;
  task.status = source.status === 'awaiting_plan' && stage === 'saved' ? 'awaiting_plan' : 'paused';
  if (restoringFlow) task.recovery = structuredClone(source.recovery ?? null);
  if (stage === 'saved' && source.status === 'blocked') {
    task.status = 'blocked';
    task.blockerDecision = structuredClone(source.blockerDecision ?? null);
    task.error = source.error;
  }
  if (stage === 'approach') {
    task.status = 'awaiting_plan';
    task.chosenApproach = null;
    task.recovery = null;
  } else if (stage === 'plan') task.chosenApproach = null;
  if (stage === 'decision') {
    task.status = 'blocked';
    task.blockerDecision = structuredClone(
      source.blockerDecision ?? blockerDecision(source, source.attempts.at(-1).handoff),
    );
    task.blockerDecision.id = randomUUID();
    task.blockerDecision.resolved = false;
    delete task.blockerDecision.resolution;
    task.error = task.blockerDecision.summary;
  }
  // A fresh worktree must collect its own verification evidence, even at a review checkpoint.
  if (task.stage === 'review' || (stage === 'saved' && source.status === 'awaiting_final')) {
    task.stage = 'verify';
    task.repositoryCursor = 0;
    task.recovery = null;
    if (task.blockerDecision) task.blockerDecision.stage = 'verify';
  }
  if (stage === 'saved' && source.status === 'completed') {
    task.stage = source.preset === 'investigate' ? 'investigate' : 'verify';
    task.repositoryCursor = 0;
    task.recovery = null;
  }
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
      for (const key of ['workspace', 'workspaceRoot', 'branch']) entry[key] = view[key];
      entry.baseCommit =
        workspaces(source).find((e) => e.repository.id === entry.repository.id).baseCommit ??
        saved.head;
      syncPrimary(task);
      store.save(task);
      await git(view.workspaceRoot, ['read-tree', '--reset', '-u', saved.workingTree], {
        timeout: 600000,
      });
      await git(view.workspaceRoot, ['read-tree', saved.indexTree], { timeout: 600000 });
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
    put(store, `forks:${sourceId}`, [
      ...records(store, `forks:${sourceId}`),
      {
        taskId: task.id,
        checkpointId,
        attemptId: record.attemptId,
        at: now,
        stage: task.stage,
        mode: stage,
        status: 'failed',
      },
    ]);
    store.event(sourceId, {
      type: 'fork',
      summary: `Continuation from ${record.stage} could not be restored; inspect the preserved workspace.`,
      continuationTaskId: task.id,
      checkpointId,
    });
    throw error;
  }
  task.reviewedFingerprint = null;
  task.verifiedFingerprint = null;
  store.save(task, {
    type: 'fork',
    summary: `Continued from ${record.role === 'debug' ? 'debugger' : record.stage} checkpoint${stage === 'approach' ? ' to choose another approach' : stage === 'decision' ? ' to revisit a debugger decision' : ''}. Earlier investigation is preserved; verification and final acceptance run again.`,
    sourceTaskId: sourceId,
    checkpointId,
  });
  put(store, `forks:${sourceId}`, [
    ...records(store, `forks:${sourceId}`),
    {
      taskId: task.id,
      checkpointId,
      attemptId: record.attemptId,
      at: now,
      stage: task.stage,
      mode: stage,
    },
  ]);
  store.event(sourceId, {
    type: 'fork',
    summary: `Created a separate continuation from ${record.stage}.`,
    continuationTaskId: task.id,
    checkpointId,
  });
  return task;
}
