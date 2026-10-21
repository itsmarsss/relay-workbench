import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a crashed server cannot leave a harness writing after recovery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-orphan-'));
  const heartbeat = join(directory, 'heartbeat');
  const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),25);`;
  const runner = join(directory, 'parent.mjs');
  const moduleURL = new URL('../server/process.js', import.meta.url).href;
  await writeFile(
    runner,
    `import {runProcess} from ${JSON.stringify(moduleURL)}; await runProcess(process.execPath,['-e',${JSON.stringify(childCode)}]);`,
  );
  const parent = spawn(process.execPath, [runner], { stdio: 'ignore' });
  t.after(async () => {
    try {
      parent.kill('SIGKILL');
    } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await readFile(heartbeat, 'utf8')).length > 2) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(ready, 'Worker must be actively writing before the simulated crash');
  const exited = new Promise((resolve) => parent.on('exit', resolve));
  parent.kill('SIGKILL');
  await exited;
  await new Promise((r) => setTimeout(r, 2500));
  const stoppedLength = (await readFile(heartbeat, 'utf8')).length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    (await readFile(heartbeat, 'utf8')).length,
    stoppedLength,
    'Orphaned process must stop writing',
  );
});
