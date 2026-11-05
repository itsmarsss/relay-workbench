import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fingerprint, git } from './workspace.js';
import { workspaces, workspaceView } from './task-repositories.js';
import { requireValue } from './domain.js';
// Portable patches preserve changes without copying a monorepo or its Git store.
export async function workspaceSnapshots(tasks, directory, backupId) {
  const files = [];
  for (const task of tasks) {
    if (task.demo) continue;
    const entries = workspaces(task);
    for (const [index, entry] of entries.entries()) {
      if (!entry.workspaceRoot) continue;
      const view = workspaceView(task, entry),
        before = await fingerprint(view);
      const prefix = `artifacts/${task.id}/backup-${backupId}/${index}`;
      const save = async (name, bytes) => {
        const path = `${prefix}/${name}`;
        await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
        await writeFile(join(directory, path), bytes, { mode: 0o600 });
        files.push(path);
      };
      const head = await git(entry.workspaceRoot, ['rev-parse', 'HEAD']);
      const patch = await git(
        entry.workspaceRoot,
        ['diff', '--binary', '--no-ext-diff', '--no-textconv', entry.baseCommit, '--'],
        { maxBytes: 64 * 1024 * 1024, raw: true },
      );
      await save('changes.patch', patch);
      const untracked = (
        await git(entry.workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
      )
        .split('\0')
        .filter(Boolean);
      for (const name of untracked) {
        requireValue(
          !name.split('/').some((p) => p === '..' || p === '.'),
          'Invalid untracked path',
        );
        const source = join(entry.workspaceRoot, name),
          stat = await lstat(source);
        requireValue(
          stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024,
          'Untracked file cannot be safely archived',
        );
        await save(`untracked/${name}`, await readFile(source));
      }
      requireValue(
        before === (await fingerprint(view)),
        'Workspace changed while creating its recovery snapshot',
        409,
      );
      await save(
        'workspace.json',
        JSON.stringify(
          {
            repositoryId: entry.repository.id,
            workspaceRoot: entry.workspaceRoot,
            branch: entry.branch,
            baseCommit: entry.baseCommit,
            head,
            fingerprint: before,
            untracked,
            restore:
              'Create a checkout with the original base commit, inspect changes.patch, then apply it and copy the untracked files. Relay does not apply patches or execute restored commands automatically. Ignored workspace files and Git object stores remain external.',
          },
          null,
          2,
        ),
      );
    }
  }
  return files;
}
