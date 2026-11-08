import { open, stat, opendir, realpath } from 'node:fs/promises';
import { join, basename, relative, isAbsolute } from 'node:path';
import { inspectRepository } from './workspace.js';
const manifests = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'];
async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
async function json(path, root) {
  let handle;
  try {
    const canonical = await realpath(path);
    if (!inside(root, canonical)) return null;
    handle = await open(canonical);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(262145);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 262144) return null;
    return JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
export async function repositorySuggestions(profile) {
  const info = await inspectRepository(profile);
  const suggestions = [],
    guidance = [];
  const add = (field, label, value, evidence) =>
    suggestions.push({ field, label, value, evidence });
  const pkg = await json(join(info.cwd, 'package.json'), info.root);
  add(
    'name',
    'Repository name',
    typeof pkg?.name === 'string' && pkg.name.trim() ? pkg.name.slice(0, 100) : basename(info.cwd),
    pkg?.name ? 'package.json name' : 'Checkout folder',
  );
  if ((await realpath(profile.path)) !== info.root)
    add('path', 'Checkout root', info.root, 'Git repository root');
  if (profile.cwd !== (info.relativeCwd || '.'))
    add(
      'cwd',
      'Working subdirectory',
      info.relativeCwd || '.',
      'Selected folder relative to the Git root',
    );
  let manager = null,
    lock = null,
    lockFolder = null;
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) manager = declared;
  for (const folder of [...new Set([info.cwd, info.root])]) {
    for (const [file, tool] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['package-lock.json', 'npm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
    ]) {
      if (await exists(join(folder, file))) {
        if (!manager) manager = tool;
        if (manager === tool) {
          lock = file;
          lockFolder = folder;
        }
      }
    }
    if (lock) break;
  }
  manager ||= 'npm';
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    for (const name of ['test', 'lint', 'typecheck', 'check'])
      if (typeof pkg.scripts[name] === 'string')
        add(
          'checks',
          `Run ${name}`,
          { command: manager, args: ['run', name] },
          `package.json scripts.${name}`,
        );
  }
  if (pkg && lock && lockFolder === info.cwd)
    add(
      'setup',
      'Install dependencies',
      {
        command: manager,
        args:
          manager === 'npm'
            ? ['ci']
            : manager === 'pnpm'
              ? ['install', '--frozen-lockfile']
              : manager === 'bun'
                ? ['install', '--frozen-lockfile']
                : declared === 'yarn' && /^yarn@[2-9]/.test(pkg.packageManager)
                  ? ['install', '--immutable']
                  : ['install', '--frozen-lockfile'],
      },
      lock,
    );
  if (await exists(join(info.cwd, 'Cargo.toml')))
    add('checks', 'Rust tests', { command: 'cargo', args: ['test'] }, 'Cargo.toml');
  if (await exists(join(info.cwd, 'go.mod')))
    add('checks', 'Go tests', { command: 'go', args: ['test', './...'] }, 'go.mod');
  for (const folder of [...new Set([info.root, info.cwd])])
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'README.md'])
      if (await exists(join(folder, file))) guidance.push(relative(info.root, join(folder, file)));
  // Bound discovery to direct packages in conventional workspace folders.
  const roots = [
    ...new Set([info.cwd, ...['packages', 'apps', 'services'].map((name) => join(info.cwd, name))]),
  ];
  let checked = 0;
  for (const parent of roots) {
    let entries;
    try {
      if (!inside(info.root, await realpath(parent))) continue;
      entries = await opendir(parent);
    } catch {
      continue;
    }
    let visited = 0;
    for await (const entry of entries) {
      if (++visited > 500) break;
      if (checked >= 100) break;
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        ['node_modules', 'vendor', 'target', 'dist', 'build'].includes(entry.name)
      )
        continue;
      checked++;
      const path = join(parent, entry.name);
      let canonical;
      try {
        canonical = await realpath(path);
      } catch {
        continue;
      }
      const rel = relative(info.root, canonical);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue;
      if ((await Promise.all(manifests.map((file) => exists(join(path, file))))).some(Boolean))
        add('cwd', 'Package subdirectory', rel, 'Contains a project manifest');
      if (suggestions.filter((s) => s.field === 'cwd').length >= 16) break;
    }
  }
  return {
    root: info.root,
    cwd: info.relativeCwd || '.',
    suggestions,
    guidance: [...new Set(guidance)],
    notes: [
      'Suggestions come from metadata; repository instructions may require different commands.',
      'Agent verification remains the default until you choose explicit checks.',
    ],
  };
}
