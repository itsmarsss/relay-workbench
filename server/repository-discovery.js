import { opendir, realpath, stat, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { requireValue } from './domain.js';
const skip = new Set([
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  'Library',
  'Applications',
  'Pictures',
  'Movies',
  'Music',
  'Downloads',
]);
export async function discoverRepositories(
  profiles,
  { root, home = homedir(), maxDirectories = 3000, maxEntries = 30000, budgetMs = 3000 } = {},
) {
  requireValue(
    root === undefined || (typeof root === 'string' && isAbsolute(root) && root.length <= 2000),
    'Choose an absolute folder path',
  );
  const candidates = root
    ? [{ path: root, depth: 4 }]
    : [
        { path: home, depth: 1 },
        ...[
          'Documents',
          'Projects',
          'Developer',
          'Development',
          'Code',
          'code',
          'dev',
          'src',
          'repos',
          'workspace',
          'workspaces',
        ].map((name) => ({ path: join(home, name), depth: 3 })),
        ...profiles.map((profile) => ({ path: dirname(profile.path), depth: 2 })),
      ];
  const queue = [],
    visited = new Map(),
    found = new Map(),
    warnings = [],
    scannedRoots = [];
  const configured = new Set(
    await Promise.all(
      profiles.map(async (p) => {
        try {
          return await realpath(p.path);
        } catch {
          return p.path;
        }
      }),
    ),
  );
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate.path);
      if (!(await stat(path)).isDirectory()) continue;
      queue.push({ ...candidate, path });
      scannedRoots.push(path);
    } catch {
      if (root) warnings.push('The selected folder is unavailable or cannot be read.');
    }
  }
  const deadline = Date.now() + budgetMs;
  let directories = 0,
    entries = 0,
    truncated = false;
  while (queue.length) {
    if (directories >= maxDirectories || entries >= maxEntries || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if ((visited.get(current.path) ?? -1) >= current.depth) continue;
    visited.set(current.path, current.depth);
    directories++;
    try {
      const marker = await lstat(join(current.path, '.git'));
      if (marker.isFile() || marker.isDirectory()) {
        found.set(current.path, {
          name: basename(current.path),
          path: current.path,
          configured: configured.has(current.path),
        });
        continue;
      }
    } catch {}
    let directory;
    try {
      directory = await opendir(current.path);
      const children = [];
      let git = false;
      for await (const entry of directory) {
        if (++entries > maxEntries || Date.now() > deadline) {
          truncated = true;
          break;
        }
        if (entry.name === '.git' && (entry.isFile() || entry.isDirectory())) git = true;
        else if (
          current.depth > 0 &&
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !skip.has(entry.name)
        )
          children.push({ path: join(current.path, entry.name), depth: current.depth - 1 });
      }
      if (git)
        found.set(current.path, {
          name: basename(current.path),
          path: current.path,
          configured: configured.has(current.path),
        });
      else queue.push(...children);
    } catch {
      if (root && current.path === scannedRoots[0])
        warnings.push('Some folders could not be read.');
    }
  }
  return {
    repositories: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    roots: [...new Set(scannedRoots)],
    directories,
    truncated,
    warnings,
  };
}
