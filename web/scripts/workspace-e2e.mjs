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
async function capture(page, name) {
  if (!process.env.RELAY_TEST_ARTIFACTS) return;
  await mkdir(process.env.RELAY_TEST_ARTIFACTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(process.env.RELAY_TEST_ARTIFACTS, name + '.png') });
}
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
  for (const [asset, contentType] of [
    ['theme.js', 'text/javascript'],
    ['relay.svg', 'image/svg+xml'],
  ]) {
    const response = await fetch(origin + '/' + asset);
    assert.equal(response.status, 200, asset + ' must be served');
    assert.ok(response.headers.get('Content-Type').startsWith(contentType));
  }
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
  await page.locator('.task-list').getByText('Workspace fixture', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New task', exact: true }).count(), 1);
  const scopes = page.getByRole('navigation', { name: 'Task status filters' });
  await scopes.getByRole('button', { name: /^Backlog/ }).click();
  assert.match(page.url(), /scope=backlog/);
  await page.reload();
  await scopes.getByRole('button', { name: /^Backlog/ }).waitFor();
  assert.equal(
    await scopes.getByRole('button', { name: /^Backlog/ }).getAttribute('aria-pressed'),
    'true',
  );
  await scopes.getByRole('button', { name: /^All tasks/ }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  assert.match(page.url(), /view=board/);
  assert.equal(await page.locator('.task-lane').count(), 1, 'Board opens on populated stages');
  await page.getByRole('checkbox', { name: 'Empty stages', exact: true }).check();
  assert.equal(await page.locator('.task-lane').count(), 10);
  await page.reload();
  await page.getByRole('checkbox', { name: 'Empty stages', exact: true }).waitFor();
  assert.ok(await page.getByRole('checkbox', { name: 'Empty stages', exact: true }).isChecked());
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const sidebarResize = page.getByRole('separator', { name: 'Resize sidebar' });
  await sidebarResize.focus();
  await sidebarResize.press('End');
  await until(
    async () => (await page.locator('.sidebar').boundingBox()).width === 340,
    'sidebar keyboard resize',
  );
  await page.reload();
  await until(
    async () => (await page.locator('.sidebar').boundingBox()).width === 340,
    'saved sidebar width',
  );
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await until(
    async () => (await page.locator('.sidebar').boundingBox()).width === 64,
    'collapsed sidebar',
  );
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await until(
    async () => (await page.locator('.sidebar').boundingBox()).width === 340,
    'restored sidebar width',
  );
  await sidebarResize.dblclick();
  await until(
    async () => (await page.locator('.sidebar').boundingBox()).width === 232,
    'reset sidebar width',
  );
  await capture(page, 'task-list');
  await page.getByRole('button', { name: 'Actions for Workspace fixture' }).click();
  await page.getByRole('button', { name: /^Move to column:/ }).click();
  await page.getByRole('option', { name: 'Completed', exact: true }).click();
  await until(
    async () =>
      (await (await fetch(origin + '/api/tasks/' + task.id)).json()).statusOverride?.value ===
      'finished',
    'board override',
  );
  assert.equal((await (await fetch(origin + '/api/tasks/' + task.id)).json()).status, 'draft');
  await page.getByRole('button', { name: 'Actions for Workspace fixture' }).click();
  await page.getByRole('button', { name: 'Delete task' }).click();
  await page.getByRole('dialog', { name: 'Delete task?' }).waitFor();
  assert.match(page.url(), /#tasks/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(origin + '/#memory');
  await page.getByRole('button', { name: 'Add memory', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Scope memory');
  await page.getByRole('button', { name: /^Memory kind:/ }).click();
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
  await page.goto(origin + '/#repositories');
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  const profileEditor = page.getByRole('dialog', { name: 'Add repository', exact: true });
  await profileEditor.getByRole('textbox', { name: 'Name', exact: true }).fill('Portable project');
  await profileEditor
    .getByRole('textbox', { name: 'Repository path', exact: true })
    .fill(directory);
  await profileEditor.getByRole('tab', { name: 'Checks & setup', exact: true }).click();
  const commands = profileEditor
    .locator('.command-list-editor')
    .filter({ has: page.getByRole('heading', { name: 'Required checks', exact: true }) });
  await commands.getByRole('button', { name: 'Add command', exact: true }).click();
  await profileEditor
    .getByRole('textbox', { name: 'Required checks 1 executable', exact: true })
    .fill('fixture-check');
  await commands.getByRole('button', { name: 'Add argument', exact: true }).click();
  const literal = 'literal; $(never-execute)';
  await profileEditor
    .getByRole('textbox', { name: 'Required checks 1 argument 1', exact: true })
    .fill(literal);
  await capture(page, 'repository-checks');
  await profileEditor.getByRole('tab', { name: 'General', exact: true }).click();
  await profileEditor.getByRole('button', { name: 'Save repository', exact: true }).click();
  await page.getByRole('heading', { name: 'Portable project', exact: true }).waitFor();
  const profile = (await (await fetch(origin + '/api/bootstrap')).json()).config.repositories.find(
    (profile) => profile.name === 'Portable project',
  );
  assert.deepEqual(profile.checks, [{ command: 'fixture-check', args: [literal] }]);
  await page.goto(origin + '/#settings');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  // Appearance lives in Settings, persists, and follows the OS in System mode.
  await page.getByRole('checkbox', { name: 'Low motion', exact: true }).check();
  await page.emulateMedia({ colorScheme: 'dark' });
  await until(
    async () => (await page.locator('html').getAttribute('data-theme')) === 'dark',
    'system dark theme',
  );
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('option', { name: 'Light', exact: true }).click();
  await page.reload();
  await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.ok(await page.getByRole('checkbox', { name: 'Low motion', exact: true }).isChecked());
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('option', { name: 'System', exact: true }).click();
  await until(
    async () => (await page.locator('html').getAttribute('data-theme')) === 'dark',
    'restored system theme',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await until(
    async () => (await page.locator('html').getAttribute('data-theme')) === 'light',
    'system light theme',
  );
  await capture(page, 'settings');
  await page.goto(origin + '/#agents');
  await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save agent settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  await page.getByText('Routing evidence', { exact: true }).click();
  await page
    .getByText('Run workflows to collect evidence. No routing changes are automatic.', {
      exact: true,
    })
    .waitFor();
  await capture(page, 'agents');
  await page.goto(origin + '/#overview');
  await page.getByRole('heading', { name: /Let’s make progress/ }).waitFor();
  await page.locator('.stat-card.attention').click();
  assert.match(page.url(), /scope=attention/);
  const workspaceURL = page.url();
  await page.getByRole('button', { name: 'Open Relay agent', exact: true }).click();
  const orchestrator = page.getByRole('dialog', { name: 'Relay orchestrator', exact: true });
  await orchestrator
    .getByRole('textbox', { name: 'Message Relay', exact: true })
    .fill('Keep this as a draft');
  await page.keyboard.press('Control+k');
  await orchestrator.waitFor({ state: 'hidden' });
  assert.equal(
    page.url(),
    workspaceURL,
    'Workspace chat leaves the underlying page and selection intact',
  );
  await page.keyboard.press('Control+k');
  await orchestrator.waitFor();
  await page.keyboard.press('Escape');
  await orchestrator.waitFor({ state: 'hidden' });
  await page.locator('main').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('n');
  const shortcutDraft = page.getByRole('dialog', { name: 'New task', exact: true });
  await shortcutDraft.waitFor();
  await page.keyboard.press('Control+k');
  assert.equal(await orchestrator.count(), 0, 'Shortcut does not open behind another dialog');
  await page.keyboard.press('Escape');
  await shortcutDraft.waitFor({ state: 'hidden' });
  const demo = await api('/api/tasks', { title: 'Workflow demo', demo: true });
  await page.goto(origin + '/#task/' + demo.id + '/overview');
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await editor.waitFor();
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.main-shell > main')).overflow,
    ),
    'hidden',
  );
  await editor.getByRole('button', { name: /^Workflow preset:/ }).click();
  await page.getByRole('option', { name: 'Small change', exact: true }).click();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await until(
    async () => (await (await fetch(origin + '/api/tasks/' + demo.id)).json()).preset === 'small',
    'editable draft preset',
  );
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.getByRole('radio', { name: 'Select Focused repair', exact: true }).waitFor();
  await page.getByRole('radio', { name: 'Select Focused repair', exact: true }).click();
  await page.getByRole('button', { name: 'Approve approach', exact: true }).click();
  await page.getByRole('button', { name: 'Accept result', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Accept result', exact: true }).click();
  await until(
    async () =>
      (await (await fetch(origin + '/api/tasks/' + demo.id)).json()).status === 'completed',
    'demo acceptance',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Publish draft PR', exact: true }).count(),
    0,
    'Demos cannot publish real changes',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Run agent', exact: true }).count(),
    0,
    'Demos cannot start live follow-ups',
  );
  await capture(page, 'task-overview');
  await page.getByRole('button', { name: 'Execution history', exact: true }).click();
  await page.getByRole('heading', { name: 'Execution', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Execution', exact: true }).scrollIntoViewIfNeeded();
  await capture(page, 'execution');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Execution', exact: true }).scrollIntoViewIfNeeded();
  for (const control of await page.locator('.execution-tools > button').all()) {
    const box = await control.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'Graph controls remain accessible on mobile');
  }
  await capture(page, 'execution-mobile');
  await page
    .getByRole('dialog', { name: 'Execution history', exact: true })
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(origin + '/#relay');
  await capture(page, 'relay-light');
  await page.screenshot({ path: join(directory, 'light.png') });
  await page.goto(origin + '/#settings');
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await page.goto(origin + '/#relay');
  await page.getByText('Finished answer', { exact: true }).waitFor();
  const unreadable = await page.evaluate(() => {
    const luminance = (color) => {
      const values = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    return [...document.querySelectorAll('main button:not(:disabled), main a')]
      .filter((element) => {
        if (!element.getBoundingClientRect().width) return false;
        let parent = element;
        let bg;
        while (parent) {
          bg = getComputedStyle(parent).backgroundColor;
          if (!bg.endsWith(', 0)') && bg !== 'transparent') break;
          parent = parent.parentElement;
        }
        const a = luminance(getComputedStyle(element).color),
          b = luminance(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5;
      })
      .map((element) => element.getAttribute('aria-label') || element.textContent);
  });
  assert.deepEqual(unreadable, [], 'Dark controls need readable contrast');
  await capture(page, 'relay-dark');
  await page.screenshot({ path: join(directory, 'dark.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await until(
    async () => (await page.locator('.sidebar').boundingBox()).height <= 64,
    'compact mobile navigation',
  );
  const composer = await page.getByRole('textbox', { name: 'Message Relay' }).boundingBox();
  assert.ok(
    composer.width >= 250 && composer.y + composer.height <= 844,
    'Mobile composer stays usable within the viewport',
  );
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'No page-wide horizontal overflow',
  );
  await capture(page, 'relay-mobile');
  await page.screenshot({ path: join(directory, 'mobile.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'Workspace browser checks passed: persistent streaming chats, mentions, edit, task filters, sidebar resizing, board overrides, context deletion, modal controls, side chat, resizing, saved URL state and repeat settings saves.',
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
