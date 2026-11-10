import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
const directory = await mkdtemp(join(tmpdir(), 'relay-workspace-e2e-')),
  root = resolve('..'),
  binary = join(directory, 'relay-go');
let server, browser;
let output = '';
async function until(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('Timed out: ' + label + ' ' + output);
}
try {
  const build = spawnSync('go', ['build', '-o', binary, './cmd/relay-go'], {
    cwd: join(root, 'go'),
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr);
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const origin = 'http://127.0.0.1:' + port;
  const agent = join(directory, 'agent');
  await writeFile(
    agent,
    `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 if(process.argv.includes('--input-format')){console.log(JSON.stringify({type:'control_response',response:{request_id:'models',subtype:'success',response:{models:[{value:'fixture-model',displayName:'Fixture model'}]}}}));return}
 console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Streaming answer'}}}));
 setTimeout(()=>console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'mcp__relay__list_tasks',input:{}}]}})),100);
 setTimeout(()=>console.log(JSON.stringify({type:'result',is_error:false,result:'**Finished answer** with a [task link](#tasks).'})),300);
});`,
    { mode: 0o700 },
  );
  server = spawn(
    binary,
    ['--data-dir', join(directory, 'state'), '--web-dir', resolve('dist'), '--port', String(port)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (d) => (output += d));
  await until(async () => (await fetch(origin + '/api/health')).ok, 'server');
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json(),
    headers = { 'Content-Type': 'application/json', 'X-Relay-Token': bootstrap.token };
  const api = async (path, body, method = 'POST') => {
    const r = await fetch(origin + path, { method, headers, body: JSON.stringify(body) });
    const value = await r.json();
    assert.ok(r.ok, JSON.stringify(value));
    return value;
  };
  bootstrap.config.harnesses.claude.command = agent;
  bootstrap.config.harnesses.codex.enabled = false;
  bootstrap.config.harnesses.pi.enabled = false;
  {
    const r = await fetch(origin + '/api/config', {
      method: 'PUT',
      headers: { ...headers, 'If-Match': bootstrap.configRevision },
      body: JSON.stringify(bootstrap.config),
    });
    assert.ok(r.ok, await r.text());
  }
  const task = await api('/api/tasks', {
    title: 'Workspace fixture',
    description: 'Full **Markdown** context',
    demo: true,
  });
  browser = await chromium.launch({ executablePath: process.env.RELAY_CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/#relay');
  const input = page.getByRole('textbox', { name: 'Message Relay' });
  await input.fill('First line');
  await input.press('Shift+Enter');
  await input.type('Second line');
  assert.equal(await input.inputValue(), 'First line\nSecond line');
  assert.ok((await input.boundingBox()).height < 100);
  await input.press('Enter');
  await page.getByText('Finished answer', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Finished answer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await input.inputValue(), 'First line\nSecond line');
  await page.getByRole('button', { name: 'Cancel edit' }).click();
  await input.fill('@Workspace');
  await page.getByRole('option').filter({ hasText: 'Workspace fixture' }).click();
  assert.match(await input.inputValue(), /#task\//);
  await input.fill('');
  await page.goto(origin + '/#tasks');
  await page.getByRole('button', { name: 'Actions for Workspace fixture' }).click();
  await page.getByRole('button', { name: 'Move to column', exact: true }).click();
  await page.getByRole('option', { name: 'Completed', exact: true }).click();
  await until(
    async () =>
      (await (await fetch(origin + '/api/tasks/' + task.id)).json()).statusOverride?.value ===
      'finished',
    'board override',
  );
  assert.equal((await (await fetch(origin + '/api/tasks/' + task.id)).json()).status, 'draft');
  await page.getByRole('button', { name: 'Actions for Workspace fixture' }).click();
  await page.getByRole('menuitem', { name: 'Delete task' }).click();
  await page.getByRole('dialog', { name: 'Delete task?' }).waitFor();
  assert.match(page.url(), /#tasks/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(origin + '/#memory');
  await page.getByRole('button', { name: 'Add memory', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Scope memory');
  await page.getByRole('button', { name: 'Memory kind', exact: true }).click();
  await page.getByRole('option', { name: 'preference', exact: true }).click();
  await page.getByRole('textbox', { name: 'Content', exact: true }).fill('Prefer focused tests');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByRole('heading', { name: 'Scope memory' }).waitFor();
  await page.goto(origin + '/#task/' + task.id + '/overview');
  await page.getByRole('button', { name: 'Ask Relay', exact: true }).click();
  assert.match(page.url(), /ask=1/);
  await page.getByRole('textbox', { name: 'Ask Relay about this task' }).fill('Inspect this task');
  await page.getByRole('textbox', { name: 'Ask Relay about this task' }).press('Enter');
  await page.getByText('Finished answer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  assert.match(page.url(), /ask=1/);
  const launcher = await page.getByRole('button', { name: 'Ask Relay', exact: true }).boundingBox(),
    handle = await page.getByRole('button', { name: 'Resize Ask Relay' }).boundingBox();
  await page.mouse.move(handle.x + 6, handle.y + 6);
  await page.mouse.down();
  await page.mouse.move(handle.x - 30, handle.y - 20, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(
    await page.getByRole('button', { name: 'Ask Relay', exact: true }).boundingBox(),
    launcher,
  );
  await page.goto(origin + '/#settings');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  const demo = await api('/api/tasks', {title:'Workflow demo',demo:true});
  await page.goto(origin + '/#task/' + demo.id + '/overview');
  await page.getByRole('button', {name:'Run demo',exact:true}).click();
  await page.getByText('Focused repair', {exact:true}).first().waitFor();
  await page.getByText('Focused repair', {exact:true}).first().click();
  await page.getByRole('button', {name:'Approve approach',exact:true}).click();
  await page.getByRole('button', {name:'Accept result',exact:true}).waitFor();
  await page.getByRole('button', {name:'Accept result',exact:true}).click();
  await until(async()=> (await (await fetch(origin+'/api/tasks/'+demo.id)).json()).status==='completed','demo acceptance');
  await page.goto(origin + '/#relay');
  await page.screenshot({ path: join(directory, 'light.png') });
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await page.screenshot({ path: join(directory, 'dark.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(directory, 'mobile.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'Workspace browser checks passed: persistent streaming chats, mentions, edit, board overrides, context deletion, modal controls, side chat, resizing, saved URL state and repeat settings saves.',
  );
} catch (error) {
  console.error('Workspace fixture output:', output);
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
  await rm(directory, { recursive: true, force: true });
}
