import { realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
export const inspectionTools = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 source file in a task worktree, with line numbers and revision evidence. Paths are relative to the repository working directory.',
    inputSchema: schema(
      {
        repositoryId: string,
        path: string,
        startLine: { type: 'integer', minimum: 1 },
        lines: { type: 'integer', minimum: 1, maximum: 300 },
      },
      ['repositoryId', 'path'],
    ),
  },
  {
    name: 'list_files',
    description:
      'List tracked and nonignored untracked files under a relative directory. Narrow the path for large repositories.',
    inputSchema: schema({ repositoryId: string, path: string }, ['repositoryId']),
  },
  {
    name: 'search',
    description:
      'Search worktree text for a literal string, including nonignored untracked files. Narrow the path for large repositories.',
    inputSchema: schema({ repositoryId: string, path: string, text: string }, [
      'repositoryId',
      'text',
    ]),
  },
  {
    name: 'git_inspect',
    description:
      'Inspect local Git status, diff, log, blame, or one commit. No shell or arbitrary Git arguments. Log text filters use literal pickaxe search. No fetches or remote access.',
    inputSchema: schema(
      {
        repositoryId: string,
        operation: { enum: ['status', 'diff', 'log', 'blame', 'show'] },
        path: string,
        commit: string,
        text: string,
        startLine: { type: 'integer', minimum: 1 },
        lines: { type: 'integer', minimum: 1, maximum: 300 },
      },
      ['repositoryId', 'operation'],
    ),
  },
];
function bounded(value, maximum = 2000) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0'))
    throw Error('Invalid inspection argument');
  return value;
}
function count(value, fallback, max) {
  value ??= fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw Error('Invalid line range');
  return value;
}
export function createInspector(repositories) {
  const entries = new Map(repositories.filter((r) => r.workspace).map((r) => [r.id, r]));
  async function target(id, path = '.') {
    const entry = entries.get(id);
    if (!entry) throw Error('No prepared worktree for this repository');
    path = bounded(path);
    if (isAbsolute(path) || path.split(/[\\/]/).some((p) => p === '..' || p === '.git'))
      throw Error('Use a relative source path inside the task worktree');
    const root = await realpath(entry.workspace);
    const actual = await realpath(resolve(root, path));
    const rel = relative(root, actual);
    if (
      rel.split(sep).includes('.git') ||
      rel === '..' ||
      rel.startsWith('..' + sep) ||
      isAbsolute(rel)
    )
      throw Error('Path leaves the task worktree');
    return { root, actual, path: rel || '.' };
  }
  async function git(root, args, allowNoMatch = false) {
    try {
      const result = await execute(
        'git',
        ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args],
        {
          cwd: root,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      return result.stdout;
    } catch (error) {
      if (allowNoMatch && error.code === 1) return error.stdout ?? '';
      throw Error(
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'Result too large; narrow the source path or query'
          : (error.stderr || error.message).slice(0, 2000),
      );
    }
  }
  return async function inspect(name, args = {}) {
    const tool = inspectionTools.find((t) => t.name === name);
    if (
      !tool ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).some((k) => !Object.hasOwn(tool.inputSchema.properties, k))
    )
      throw Error('Unsupported inspection request');
    const t = await target(args.repositoryId, args.path);
    const headBefore = (await git(t.root, ['rev-parse', 'HEAD'])).trim();
    let result;
    if (name === 'read_file') {
      const file = await open(t.actual, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 512 * 1024)
          throw Error('Read a regular source file under 512 KiB');
        const buffer = Buffer.alloc(512 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > 512 * 1024) throw Error('File grew beyond the inspection limit');
        const content = buffer.subarray(0, length).toString('utf8');
        if (content.includes('\0')) throw Error('Binary files are unavailable');
        const after = await file.stat();
        const start = count(args.startLine, 1, 10000000),
          lines = count(args.lines, 200, 300);
        result = {
          path: t.path,
          content: content
            .split('\n')
            .slice(start - 1, start - 1 + lines)
            .map((line, i) => `${start + i}: ${line}`)
            .join('\n'),
          contentHash: createHash('sha256').update(content).digest('hex'),
          changedDuringRead: before.mtimeMs !== after.mtimeMs || before.size !== after.size,
        };
      } finally {
        await file.close();
      }
    } else if (name === 'list_files') {
      result = {
        output: await git(t.root, [
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '--',
          t.path,
        ]),
      };
    } else if (name === 'search') {
      const text = bounded(args.text, 300);
      if (!text) throw Error('Enter a nonempty literal search');
      result = {
        output: await git(
          t.root,
          ['grep', '-n', '-I', '-F', '--untracked', '--exclude-standard', '-e', text, '--', t.path],
          true,
        ),
      };
    } else {
      const noDiffHelpers = ['--no-ext-diff', '--no-textconv'];
      const commit = args.commit === undefined ? null : bounded(args.commit, 64);
      if (commit && !/^[a-f0-9]{7,64}$/i.test(commit))
        throw Error('Commit must be a hexadecimal object ID');
      let command;
      if (args.operation === 'status')
        command = ['status', '--porcelain=v1', '--untracked-files=normal', '--', t.path];
      else if (args.operation === 'diff')
        command = ['diff', ...noDiffHelpers, '--no-renames', 'HEAD', '--', t.path];
      else if (args.operation === 'log')
        command = [
          'log',
          '--no-show-signature',
          ...noDiffHelpers,
          '-n',
          '20',
          '--format=fuller',
          '--stat',
          ...(args.text ? ['-S', bounded(args.text, 300)] : []),
          '--',
          t.path,
        ];
      else if (args.operation === 'blame') {
        if (!args.path || t.path === '.') throw Error('Blame requires a source file path');
        const start = count(args.startLine, 1, 10000000),
          lines = count(args.lines, 100, 300);
        command = ['blame', '--no-textconv', '-L', `${start},+${lines}`, '--', t.path];
      } else if (args.operation === 'show' && commit)
        command = [
          'show',
          '--no-show-signature',
          ...noDiffHelpers,
          '--no-renames',
          '--format=fuller',
          commit,
          '--',
          t.path,
        ];
      else throw Error('Unsupported Git inspection operation');
      result = { output: await git(t.root, command) };
    }
    const headAfter = (await git(t.root, ['rev-parse', 'HEAD'])).trim();
    return {
      repositoryId: args.repositoryId,
      observedAt: new Date().toISOString(),
      headBefore,
      headAfter,
      liveWorktree: true,
      ...result,
      revisionChanged: headBefore !== headAfter,
      note: 'Working files may change while the pipeline runs. This is live evidence, not an atomic snapshot.',
    };
  };
}
