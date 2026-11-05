import { readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { workspaces, syncPrimary } from './task-repositories.js';
import { git, inspectRepository } from './workspace.js';
import { runProcess } from './process.js';
import { requireValue } from './domain.js';
export async function diskUsage(root, budget = { remaining: 200000 }) {
  let bytes = 0,
    files = 0,
    truncated = false;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (--budget.remaining < 0) {
        truncated = true;
        break;
      }
      const path = join(root, entry.name),
        stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const nested = await diskUsage(path, budget);
        bytes += nested.bytes;
        files += nested.files;
        truncated ||= nested.truncated;
      } else {
        bytes += stat.size;
        files++;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { bytes, files, truncated };
}
export async function cleanupCandidate(task, entry, directory) {
  const result = {
    taskId: task.id,
    repositoryId: entry.repository.id,
    title: task.title,
    repository: entry.repository.name,
    path: entry.workspaceRoot,
    eligible: false,
    reason: '',
    bytes: 0,
    files: 0,
  };
  if (!entry.workspaceRoot || task.demo) return { ...result, reason: 'No local worktree' };
  if (entry.repository.strategy !== 'worktree')
    return {
      ...result,
      reason: 'Attached and custom managed checkouts require their own lifecycle tools',
    };
  if (!['completed', 'cancelled'].includes(task.status))
    return { ...result, reason: 'Task has not finished' };
  try {
    const expected = join(
      directory,
      'worktrees',
      workspaces(task).length > 1 ? `${task.id}-${workspaces(task).indexOf(entry)}` : task.id,
    );
    requireValue(
      resolve(entry.workspaceRoot) === resolve(expected),
      'Workspace is outside its Relay-owned location',
    );
    requireValue(!(await lstat(expected)).isSymbolicLink(), 'Workspace is a symbolic link');
    const canonicalParent = join(await realpath(directory), 'worktrees');
    requireValue(
      (await realpath(join(directory, 'worktrees'))) === canonicalParent,
      'Worktree directory is a symbolic link',
    );
    requireValue(
      (await realpath(expected)) ===
        join(canonicalParent, relative(join(directory, 'worktrees'), expected)),
      'Workspace path contains a symbolic link',
    );
    const owner = await inspectRepository(entry.repository);
    const ownerCommon = await realpath(
      await git(owner.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    requireValue(
      (await realpath(
        await git(expected, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      )) === ownerCommon,
      'Worktree ownership changed',
    );
    const head = await git(expected, ['rev-parse', 'HEAD']);
    const branch = await git(expected, ['symbolic-ref', '--short', 'HEAD']);
    requireValue(branch === entry.branch && branch.startsWith('relay/'), 'Worktree branch changed');
    requireValue(
      !(await git(expected, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching',
      ])),
      'Worktree contains modified, untracked or ignored files',
    );
    let preserved = head === entry.baseCommit;
    for (const name of ['main', 'master', 'trunk']) {
      if (preserved) break;
      const check = await runProcess(
        'git',
        ['-C', owner.root, 'merge-base', '--is-ancestor', head, `refs/heads/${name}`],
        { timeout: 10000 },
      );
      if (check.code === 0) preserved = true;
    }
    requireValue(
      preserved,
      'Worktree has commits not reachable from its base or a local main branch',
    );
    Object.assign(result, await diskUsage(expected));
    result.eligible = true;
    result.reason = 'Clean, finished worktree; branch and task history will be retained';
    result.token = createHash('sha256')
      .update(JSON.stringify([task.id, entry.repository.id, expected, head, branch, task.status]))
      .digest('hex');
  } catch (error) {
    result.reason = error.message;
  }
  return result;
}
export async function lifecycleReport(store) {
  const entries = [];
  for (const task of store.all())
    for (const entry of workspaces(task))
      if (entry.workspaceRoot) entries.push(await cleanupCandidate(task, entry, store.directory));
  const storage = {};
  for (const name of ['attachments', 'artifacts', 'backups', 'worktrees'])
    storage[name] = await diskUsage(join(store.directory, name));
  const backups = [];
  for (const name of await readdir(join(store.directory, 'backups')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!/^[a-f0-9-]{36}\.relay\.gz$/.test(name)) continue;
    const stat = await lstat(join(store.directory, 'backups', name));
    if (stat.isFile() && !stat.isSymbolicLink())
      backups.push({
        id: name.slice(0, 36),
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        downloadUrl: `/api/backups/${name.slice(0, 36)}`,
      });
  }
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { entries, storage, backups: backups.slice(0, 100) };
}
export async function cleanupWorktree(store, data) {
  const task = store.get(data.taskId);
  requireValue(task, 'Task not found', 404);
  const entry = workspaces(task).find((r) => r.repository.id === data.repositoryId);
  requireValue(entry, 'Repository not found', 404);
  const actual = entry.workspaceRoot ? await realpath(entry.workspaceRoot).catch(() => null) : null;
  for (const other of store.all())
    if (other.id !== task.id)
      for (const reference of workspaces(other))
        if (reference.workspaceRoot)
          requireValue(
            (await realpath(reference.workspaceRoot).catch(() => null)) !== actual || !actual,
            'Another task still references this worktree',
            409,
          );
  const preview = await cleanupCandidate(task, entry, store.directory);
  requireValue(
    preview.eligible && preview.token === data.token,
    preview.reason || 'Cleanup preview changed; refresh',
    409,
  );
  const owner = await inspectRepository(entry.repository);
  await git(owner.root, ['worktree', 'remove', entry.workspaceRoot]);
  entry.cleanedWorkspace = {
    path: entry.workspaceRoot,
    branch: entry.branch,
    at: new Date().toISOString(),
  };
  entry.workspace = null;
  entry.workspaceRoot = null;
  syncPrimary(task);
  store.save(task, {
    type: 'workspace',
    summary: `Removed clean worktree for ${entry.repository.name}. Branch retained.`,
  });
  return { ok: true };
}
