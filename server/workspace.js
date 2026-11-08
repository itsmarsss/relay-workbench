import { realpath, mkdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from './process.js';
import { requireValue } from './domain.js';
import { workspaces, workspaceView } from './task-repositories.js';

export async function git(cwd, args, options = {}) {
  const { raw = false, ...processOptions } = options;
  const result = await runProcess('git', ['-C', cwd, ...args], {
    timeout: 120000,
    ...processOptions,
  });
  if (result.code !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return raw ? result.stdout : result.stdout.trimEnd();
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
export async function prepareWorkspace(task, directory, allTasks, options = {}) {
  if (task.workspace) {
    await realpath(task.workspace);
    return;
  }
  const info = await inspectRepository(task.repository);
  task.baseCommit ??= await git(info.root, ['rev-parse', 'HEAD']);
  await options.checkpoint?.(task);
  if (task.repository.strategy === 'attach') {
    const occupied = allTasks.find(
      (other) =>
        other.id !== task.id &&
        workspaces(other).some((entry) => entry.workspaceRoot === info.root) &&
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
  } else if (task.repository.strategy === 'managed') {
    const branch = `relay/${task.id}`;
    const values = {
      taskId: task.id,
      workspaceName: `relay-${task.id}`,
      branch,
      baseCommit: task.baseCommit,
    };
    const expand = (value) =>
      value.replace(/\{(taskId|workspaceName|branch|baseCommit)\}/g, (_, key) => values[key]);
    const path = expand(task.repository.workspacePath);
    requireValue(isAbsolute(path), 'Managed workspace path must be absolute');
    const cmd = task.repository.workspaceCommand;
    const result = await runProcess(cmd.command, cmd.args.map(expand), {
      cwd: info.root,
      timeout: 600000,
      ...options,
    });
    requireValue(
      result.code === 0,
      `Managed workspace creation failed: ${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`,
    );
    const target = await inspectRepository({
      ...task.repository,
      path,
      cwd: info.relativeCwd || '.',
    });
    requireValue(target.root !== info.root, 'Workspace manager must create a separate checkout');
    const sourceCommon = await realpath(
      await git(info.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    const targetCommon = await realpath(
      await git(target.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    requireValue(
      sourceCommon === targetCommon,
      'Managed workspace belongs to a different repository',
    );
    requireValue(
      (await git(target.root, ['symbolic-ref', '--short', 'HEAD'])) === branch,
      'Managed workspace has an unexpected branch',
    );
    requireValue(
      (await git(target.root, ['rev-parse', 'HEAD'])) === task.baseCommit,
      'Managed workspace has an unexpected base commit',
    );
    requireValue(
      !(await git(target.root, ['status', '--porcelain', '--untracked-files=normal'])),
      'New managed workspace must be clean',
    );
    task.workspaceRoot = target.root;
    task.workspace = target.cwd;
    task.branch = branch;
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
  if (workspaces(task).length > 1) {
    const values = [];
    for (const entry of workspaces(task))
      values.push([entry.repository.id, await fingerprint(workspaceView(task, entry))]);
    return createHash('sha256').update(JSON.stringify(values)).digest('hex');
  }
  const root = task.workspaceRoot;
  const hash = createHash('sha256');
  hash.update(await git(root, ['rev-parse', 'HEAD']));
  hash.update(await git(root, ['diff', '--binary', 'HEAD', '--'], { raw: true }));
  hash.update(await git(root, ['diff', '--cached', '--binary', '--'], { raw: true }));
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
export async function diff(task, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (workspaces(task).length > 1) {
    const repositories = [];
    for (const entry of workspaces(task))
      repositories.push({
        repositoryId: entry.repository.id,
        name: entry.repository.name,
        baseCommit: entry.baseCommit,
        ...(await diff(workspaceView(task, entry), { maxBytes })),
      });
    return { repositories };
  }
  if (!task.workspace || task.demo) return { text: '', stat: '', untracked: [], demo: task.demo };
  let omitted = false;
  const bounded = async (args, raw = false) => {
    try {
      return await git(task.workspaceRoot, args, { maxBytes, raw });
    } catch (error) {
      if (error.code !== 'OUTPUT_LIMIT') throw error;
      omitted = true;
      return '';
    }
  };
  const [text, stat, names] = await Promise.all([
    bounded(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-color',
        '--no-renames',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-ext-diff',
        '--no-textconv',
        task.baseCommit,
        '--',
      ],
      true,
    ),
    bounded(['diff', '--stat', task.baseCommit, '--']),
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
  return {
    text: omitted ? '' : text,
    stat,
    untracked,
    ...(omitted
      ? {
          omitted: true,
          reason:
            'Diff exceeds the preview limit. Inspect changes locally; no partial patch is used as evidence.',
        }
      : {}),
  };
}
