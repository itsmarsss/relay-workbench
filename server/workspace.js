import { realpath, mkdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from './process.js';
import { requireValue } from './domain.js';

export async function git(cwd, args, options = {}) {
  const result = await runProcess('git', ['-C', cwd, ...args], { timeout: 120000, ...options });
  if (result.code !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trimEnd();
}
export async function inspectRepository(profile) {
  requireValue(isAbsolute(profile.path), 'Repository path must be absolute');
  const path = await realpath(profile.path);
  const root = await realpath(await git(path, ['rev-parse', '--show-toplevel']));
  const cwd = await realpath(resolve(path, profile.cwd));
  const rel = relative(root, cwd);
  requireValue(
    rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel),
    'Working directory must be inside the repository',
  );
  return { root, cwd, relativeCwd: rel };
}
export async function prepareWorkspace(task, directory, allTasks) {
  if (task.workspace) {
    await realpath(task.workspace);
    return;
  }
  const info = await inspectRepository(task.repository);
  task.baseCommit = await git(info.root, ['rev-parse', 'HEAD']);
  if (task.repository.strategy === 'attach') {
    const occupied = allTasks.find(
      (other) =>
        other.id !== task.id &&
        other.workspaceRoot === info.root &&
        !['completed', 'cancelled'].includes(other.status),
    );
    requireValue(
      !occupied,
      'This checkout is already reserved by another task. Complete or cancel that task first.',
      409,
    );
    const dirty = await git(info.root, ['status', '--porcelain', '--untracked-files=normal']);
    requireValue(
      !dirty,
      'Attached checkout must be clean before starting. Commit or preserve your existing changes first.',
      409,
    );
    task.branch = await git(info.root, ['symbolic-ref', '--short', 'HEAD']);
    requireValue(
      !['main', 'master', 'trunk'].includes(task.branch),
      'Attach a feature branch, rather than a protected base branch',
    );
    task.workspace = info.cwd;
    task.workspaceRoot = info.root;
  } else {
    const branch = `relay/${task.id.slice(0, 8)}`;
    const path = join(directory, 'worktrees', task.id);
    await mkdir(join(directory, 'worktrees'), { recursive: true });
    await git(info.root, ['worktree', 'add', '-b', branch, path, task.baseCommit]);
    task.branch = branch;
    task.workspaceRoot = path;
    task.workspace = join(path, info.relativeCwd);
    await realpath(task.workspace);
  }
}
export async function fingerprint(task) {
  const root = task.workspaceRoot;
  const hash = createHash('sha256');
  hash.update(await git(root, ['rev-parse', 'HEAD']));
  hash.update(await git(root, ['diff', '--binary', 'HEAD', '--']));
  hash.update(await git(root, ['diff', '--cached', '--binary', '--']));
  const names = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const name of names.split('\0').filter(Boolean).sort()) {
    const path = join(root, name);
    const stat = await lstat(path);
    requireValue(
      !stat.isSymbolicLink(),
      'Untracked symlinks require manual inspection before continuing',
    );
    requireValue(stat.size <= 16 * 1024 * 1024, `Untracked file is too large to inspect: ${name}`);
    hash.update(name);
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}
export async function diff(task) {
  if (!task.workspace || task.demo) return { text: '', stat: '', untracked: [], demo: task.demo };
  const [text, stat, names] = await Promise.all([
    git(task.workspaceRoot, ['diff', '--no-ext-diff', '--no-textconv', task.baseCommit, '--'], {
      maxBytes: 4 * 1024 * 1024,
    }),
    git(task.workspaceRoot, ['diff', '--stat', task.baseCommit, '--']),
    git(task.workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const untracked = [];
  for (const name of names.split('\0').filter(Boolean)) {
    const path = join(task.workspaceRoot, name);
    const stat = await lstat(path);
    let content = '[File over 200 KB or symlink; inspect locally]';
    if (stat.isFile() && stat.size < 200000) {
      const bytes = await readFile(path);
      content = bytes.includes(0) ? '[Binary file; inspect locally]' : bytes.toString('utf8');
    }
    untracked.push({ name, content });
  }
  return { text, stat, untracked };
}
