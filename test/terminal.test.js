import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, executableExists } from '../server/process.js';

const hasTmux = await executableExists('tmux');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for terminal');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-terminal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test(
  'tmux streams literal input, captures failures, and removes its socket',
  { skip: !hasTmux },
  async (t) => {
    const cwd = await fixture(t);
    let terminal;
    const lines = [];
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        `process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(s);console.error('failure evidence');process.exit(7)});`,
      ],
      {
        cwd,
        input: '`literal` $HOME $(nope)',
        terminal: { name: 'literal' },
        onTerminal: (info) => {
          terminal = info;
        },
        onLine: (line) => lines.push(line),
        timeout: 10000,
      },
    );
    assert.equal(result.code, 7);
    assert.equal(result.stdout.trim(), '`literal` $HOME $(nope)');
    assert.equal(result.stderr.trim(), 'failure evidence');
    assert.ok(lines.includes('failure evidence'));
    assert.match(terminal.attachCommand, /attach-session/);
    assert.notEqual(
      spawnSync('tmux', ['-S', terminal.socket, 'has-session', '-t', terminal.session]).status,
      0,
    );
  },
);

test(
  'manual terminal accepts input in its real workspace and stops on return',
  { skip: !hasTmux },
  async (t) => {
    const cwd = await fixture(t);
    const controller = new AbortController();
    let terminal;
    const running = runProcess('/bin/sh', ['-i'], {
      cwd,
      signal: controller.signal,
      terminal: { name: 'manual', interactive: true },
      onTerminal: (info) => {
        terminal = info;
      },
    });
    t.after(async () => {
      controller.abort();
      await running.catch(() => {});
    });
    await until(() => terminal);
    const command = `echo manual > marker.txt`;
    assert.equal(
      spawnSync('tmux', ['-S', terminal.socket, 'send-keys', '-t', terminal.session, '-l', command])
        .status,
      0,
    );
    spawnSync('tmux', ['-S', terminal.socket, 'send-keys', '-t', terminal.session, 'Enter']);
    await until(async () => {
      try {
        return (await readFile(join(cwd, 'marker.txt'), 'utf8')).trim() === 'manual';
      } catch {
        return false;
      }
    });
    controller.abort();
    await assert.rejects(running, /cancelled/);
    assert.notEqual(spawnSync('tmux', ['-S', terminal.socket, 'has-session']).status, 0);
  },
);

test(
  'server crash stops a stubborn tmux agent and its descendants',
  { skip: !hasTmux },
  async (t) => {
    const directory = await fixture(t);
    const heartbeat = join(directory, 'heartbeat');
    const infoPath = join(directory, 'terminal.json');
    const childCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>{},100);`;
    const runner = join(directory, 'parent.mjs');
    await writeFile(
      runner,
      `import {writeFileSync} from 'node:fs'; import {runProcess} from ${JSON.stringify(new URL('../server/process.js', import.meta.url).href)}; await runProcess(process.execPath,['-e',${JSON.stringify(childCode)}],{cwd:${JSON.stringify(directory)},terminal:{name:'crash'},onTerminal:(info)=>writeFileSync(${JSON.stringify(infoPath)},JSON.stringify(info))});`,
    );
    const parent = spawn(process.execPath, [runner], { stdio: 'ignore' });
    t.after(() => {
      parent.kill('SIGKILL');
    });
    await until(async () => {
      try {
        return (await readFile(heartbeat, 'utf8')).length > 2;
      } catch {
        return false;
      }
    });
    const terminal = JSON.parse(await readFile(infoPath, 'utf8'));
    const exited = new Promise((r) => parent.once('exit', r));
    parent.kill('SIGKILL');
    await exited;
    await sleep(3000);
    const size = (await readFile(heartbeat, 'utf8')).length;
    await sleep(250);
    assert.equal(
      (await readFile(heartbeat, 'utf8')).length,
      size,
      'No descendant may write after recovery',
    );
    assert.notEqual(spawnSync('tmux', ['-S', terminal.socket, 'has-session']).status, 0);
  },
);

test('returning control terminates interactive background jobs', { skip: !hasTmux }, async (t) => {
  const cwd = await fixture(t);
  const heartbeat = join(cwd, 'background');
  const script = join(cwd, 'background.cjs');
  await writeFile(
    script,
    `const fs=require('node:fs');process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`,
  );
  const controller = new AbortController();
  let terminal;
  const running = runProcess('/bin/sh', ['-i'], {
    cwd,
    signal: controller.signal,
    terminal: { name: 'background', interactive: true },
    onTerminal: (info) => {
      terminal = info;
    },
  });
  t.after(async () => {
    controller.abort();
    await running.catch(() => {});
  });
  await until(() => terminal);
  spawnSync('tmux', [
    '-S',
    terminal.socket,
    'send-keys',
    '-t',
    terminal.session,
    '-l',
    `'${process.execPath}' '${script}' &`,
  ]);
  spawnSync('tmux', ['-S', terminal.socket, 'send-keys', '-t', terminal.session, 'Enter']);
  await until(async () => {
    try {
      return (await readFile(heartbeat, 'utf8')).length > 2;
    } catch {
      return false;
    }
  });
  controller.abort();
  await assert.rejects(running, /cancelled/);
  const size = (await readFile(heartbeat, 'utf8')).length;
  await sleep(250);
  assert.equal((await readFile(heartbeat, 'utf8')).length, size);
});
