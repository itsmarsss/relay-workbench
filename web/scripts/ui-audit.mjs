import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import axe from 'axe-core';
import { chromium } from 'playwright';

// Disposable state only: this suite never connects to a running Relay instance.
const directory = await mkdtemp(join(tmpdir(), 'relay-ui-audit-'));
const artifacts = process.env.RELAY_TEST_ARTIFACTS;
const root = resolve('..');
const failures = [],
  errors = [],
  requests = [],
  screens = [];
let server,
  browser,
  page,
  serverOutput = '';
async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('Timed out: ' + label);
}
async function capture(name) {
  if (!artifacts) return;
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: join(artifacts, name + '.png') });
}
async function anchored(trigger, popup, label) {
  await until(async () => {
    const field = await trigger.boundingBox(),
      menu = await popup.boundingBox();
    return (
      field &&
      menu &&
      (Math.abs(menu.y - field.y - field.height - 6) <= 1 ||
        Math.abs(field.y - menu.y - menu.height - 6) <= 1 ||
        Math.abs(menu.y - field.y - field.height - 5) <= 1 ||
        Math.abs(field.y - menu.y - menu.height - 5) <= 1)
    );
  }, label + ' stays attached to its field');
  const bounds = await popup.boundingBox(),
    viewport = page.viewportSize();
  assert.ok(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= viewport.width + 1 &&
      bounds.y + bounds.height <= viewport.height + 1,
    label + ' fits the viewport',
  );
  assert.ok(
    await popup.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [
        [r.left + 4, r.top + 4],
        [r.right - 4, r.bottom - 4],
      ].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
    }),
    label + ' is not clipped or covered',
  );
}
async function pointerClick(locator) {
  const rect = await locator.boundingBox();
  assert.ok(rect, 'Pointer target is visible');
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  assert.ok(
    await locator.evaluate(
      (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
      point,
    ),
    'Pointer target is not covered',
  );
  await page.mouse.click(point.x, point.y);
}
async function audit(name, accessibility = true) {
  await until(
    () => page.locator('.topbar-actions [aria-label="New task"]').isEnabled(),
    'session ready',
  );
  await page.waitForTimeout(80);
  const geometry = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      mainOverflow: main.scrollWidth > main.clientWidth + 1,
      dialogOverflow: [...document.querySelectorAll('dialog[open]')].some((d) => {
        const r = d.getBoundingClientRect();
        return r.left < 0 || r.right > innerWidth + 1 || r.top < 0 || r.bottom > innerHeight + 1;
      }),
    };
  });
  for (const [key, value] of Object.entries(geometry))
    if (value) failures.push({ name, issue: key });
  if (accessibility) {
    await page.evaluate(axe.source);
    const violations = await page.evaluate(async () => {
      const result = await axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
      });
      return result.violations.map((v) => ({
        rule: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      }));
    });
    failures.push(...violations.map((violation) => ({ name, ...violation })));
  }
  screens.push(name);
  await capture(name);
}
try {
  const binary = join(directory, 'relay-go');
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
  server = spawn(
    binary,
    ['--data-dir', join(directory, 'state'), '--web-dir', resolve('dist'), '--port', String(port)],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [server.stdout, server.stderr])
    stream.on('data', (d) => (serverOutput += d));
  await until(async () => {
    try {
      return (await fetch(origin + '/api/health')).ok;
    } catch {
      return false;
    }
  }, 'server');
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Relay-Token': bootstrap.token };
  async function api(path, body, method = 'POST', extra = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  }
  const fixture = join(directory, 'fixture');
  await mkdir(fixture);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: fixture }).status, 0);
  const config = bootstrap.config;
  const agent = join(directory, 'agent');
  await writeFile(
    agent,
    `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 if(process.argv.includes('--input-format')){console.log(JSON.stringify({type:'control_response',response:{request_id:'models',subtype:'success',response:{models:[{value:'fixture-model',displayName:'Fixture model'}]}}}));return;}
 console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Streaming answer'}}}));
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'mcp__relay__list_tasks',input:{}}]}}));
 console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'[]'}]}}));
 setTimeout(()=>console.log(JSON.stringify({type:'result',is_error:false,result:'**Audit answer** with a [task link](#tasks).\\n\\n'+('A readable paragraph of context. '.repeat(100))})),300);
});`,
    { mode: 0o700 },
  );
  config.harnesses.claude.command = agent;
  config.harnesses.codex.enabled = false;
  config.harnesses.pi.enabled = false;
  config.workspaceAgent = {
    ...config.workspaceAgent,
    provider: 'claude',
    model: 'audit-model-with-a-long-identifier-'.repeat(4),
  };
  config.repositories = ['API service', 'Shared library'].map((name, i) => ({
    id: 'fixture-' + i,
    name,
    path: i ? directory : fixture,
    cwd: '.',
    strategy: 'worktree',
    verificationMode: 'agent',
    instructions: '',
    checks: [],
    setup: [],
  }));
  await api('/api/config', config, 'PUT', { 'If-Match': bootstrap.configRevision });
  const task = await api('/api/tasks', {
    title: 'Audit ' + 'EdgeCase'.repeat(18),
    description:
      '# Requirements\n\n' +
      'Full **Markdown** context and a [reference](https://example.test).\n\n'.repeat(25),
    ticket: 'https://example.test/issues/42',
    demo: true,
  });
  for (let i = 0; i < 15; i++)
    await api('/api/tasks', { title: `Queue fixture ${i + 1}`, demo: true });
  browser = await chromium.launch({ executablePath: process.env.RELAY_CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(origin))
      requests.push({ url: response.url().replace(origin, ''), status: response.status() });
  });
  await page.route('**/api/bootstrap', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.goto(origin + '/#settings');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Low motion', exact: true }).check();
  await page.goto(origin + '/#tasks');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await until(
    async () => (await page.locator('.task-list .task-card').count()) === 16,
    'loaded task queue',
  );

  // Navigation must reset page scrolling, while data refreshes preserve it.
  await page.locator('main').evaluate((el) => {
    el.scrollTop = 600;
  });
  const before = await page.locator('main').evaluate((el) => el.scrollTop);
  assert.ok(before > 0);
  await page.evaluate(() => dispatchEvent(new Event('relay-data-change')));
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator('main').evaluate((el) => el.scrollTop),
    before,
    'Refresh preserves reading position',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  if (await page.locator('main').evaluate((el) => el.scrollTop > 0))
    failures.push({ name: 'navigation', issue: 'New page retains old scroll position' });

  await page.getByRole('button', { name: 'Open Relay agent', exact: true }).click();
  await page.getByRole('dialog', { name: 'Relay orchestrator', exact: true }).waitFor();
  await audit('relay-orchestrator');
  await page.keyboard.press('Escape');

  // Searchable selects: keyboard selection, empty results and focus restoration.
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^All tasks/ })
    .click();
  const sort = page.getByRole('button', { name: /^Sort tasks:/ });
  await sort.press('ArrowDown');
  const search = page.getByRole('combobox', { name: 'Search Sort tasks', exact: true });
  await search.fill('Title');
  await search.press('Enter');
  assert.match(await sort.getAttribute('aria-label'), /Title/);
  assert.ok(await sort.evaluate((el) => el === document.activeElement));
  await sort.click();
  await search.fill('no-such-sort');
  await page.getByText('No matches.', { exact: true }).waitFor();
  await anchored(sort, page.locator('.select-popover'), 'Filtered sort menu');
  await audit('select-no-results');
  await search.press('Escape');
  await sort.click();
  await search.press('Shift+Tab');
  assert.ok(
    await page
      .getByRole('button', { name: /^Filter stage:/ })
      .evaluate((el) => el === document.activeElement),
    'Shift+Tab returns to the previous field',
  );
  await page.getByRole('button', { name: /^Filter stage:/ }).click();
  await page.getByRole('combobox', { name: 'Search Filter stage', exact: true }).press('Tab');
  assert.ok(
    await sort.evaluate((el) => el === document.activeElement),
    'Tab moves to the next field',
  );
  await sort.click();
  await page.locator('main').evaluate((el) => {
    el.scrollTop = 600;
  });
  await page.locator('.select-popover').waitFor({ state: 'hidden' });
  await page.locator('main').evaluate((el) => {
    el.scrollTop = 0;
  });
  const contextCard = page.locator('.task-card').first();
  const cardSize = await contextCard.boundingBox();
  await contextCard.click({
    button: 'right',
    position: { x: cardSize.width - 12, y: cardSize.height - 12 },
  });
  const taskActions = page.getByRole('dialog', { name: 'Task actions', exact: true });
  await taskActions.waitFor();
  const actionsBounds = await taskActions.boundingBox();
  assert.ok(
    actionsBounds.x >= 0 &&
      actionsBounds.y >= 0 &&
      actionsBounds.x + actionsBounds.width <= 1512 &&
      actionsBounds.y + actionsBounds.height <= 982,
    'Task actions fit the viewport',
  );
  const moveColumn = page.getByRole('button', { name: /^Move to column:/ });
  await moveColumn.click();
  await anchored(moveColumn, page.locator('.select-popover'), 'Task action menu');
  await audit('task-action-dropdown');
  await page.keyboard.press('Escape');
  assert.ok(await taskActions.isVisible(), 'Escape preserves the parent task menu');
  await page.keyboard.press('Escape');
  await taskActions.waitFor({ state: 'hidden' });

  // Short menus opening upward must use their real height, including after filtering.
  await page.goto(origin + '/#agents');
  const reviewProvider = page.getByRole('button', { name: /^review provider:/ });
  await reviewProvider.click();
  await anchored(reviewProvider, page.locator('.select-popover'), 'Upward provider menu');
  assert.equal(await page.locator('.select-popover').getAttribute('data-side'), 'top');
  await page.getByRole('combobox', { name: 'Search review provider', exact: true }).fill('Claude');
  await anchored(reviewProvider, page.locator('.select-popover'), 'Shortened provider menu');
  await page.getByRole('combobox', { name: 'Search review provider', exact: true }).fill('');
  await page.locator('main').evaluate((el) => {
    el.scrollTop += 60;
  });
  await anchored(reviewProvider, page.locator('.select-popover'), 'Scrolled provider menu');
  await audit('provider-menu-placement');
  await page.keyboard.press('Escape');
  await page.goto(origin + '/#tasks?view=list');

  // Native validation, Markdown preview, focus trapping and nested modal selects.
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await dialog.getByRole('button', { name: 'Create draft', exact: true }).click();
  assert.ok(
    await dialog
      .getByRole('textbox', { name: 'Title', exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('UI-created demo');
  await dialog
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Paragraph with **emphasis**.\n\n- One\n- Two');
  const description = dialog.getByRole('textbox', { name: 'Description', exact: true });
  await description.evaluate((el) => el.setSelectionRange(0, 9));
  await dialog.getByRole('button', { name: 'Bold', exact: true }).click();
  assert.match(await description.inputValue(), /^\*\*Paragraph\*\* with/);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  assert.deepEqual(await dialog.locator('.markdown-preview strong').allTextContents(), [
    'Paragraph',
    'emphasis',
  ]);
  await dialog.getByRole('checkbox', { name: /Demo/ }).check();
  await audit('new-task-dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(
    await page
      .getByRole('button', { name: 'New task', exact: true })
      .evaluate((el) => el === document.activeElement),
  );

  await page.goto(origin + '/#repositories');
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add repository', exact: true });
  await dialog.getByRole('tab', { name: 'General', exact: true }).press('ArrowRight');
  await dialog.getByRole('tab', { name: 'General', exact: true }).press('End');
  await dialog.getByRole('tab', { name: 'Guidance', exact: true }).press('Home');
  await dialog.getByRole('tab', { name: 'General', exact: true }).press('ArrowRight');
  assert.ok(await dialog.getByRole('radio', { name: 'New worktree', exact: true }).isChecked());
  await dialog.getByRole('tab', { name: 'General', exact: true }).click();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.goto(origin + '/#memory');
  await page.getByRole('button', { name: 'Add memory', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add memory', exact: true });
  await page.getByRole('button', { name: /^Memory kind:/ }).click();
  await anchored(
    page.getByRole('button', { name: /^Memory kind:/ }),
    page.locator('.select-popover'),
    'Modal memory menu',
  );
  await audit('repository-select-dialog');
  await page.getByRole('combobox', { name: 'Search Memory kind', exact: true }).press('Escape');
  assert.ok(await dialog.isVisible(), 'Escape closes the dropdown before the dialog');
  await page.getByRole('button', { name: /^Memory kind:/ }).click();
  await page.setViewportSize({ width: 390, height: 500 });
  await anchored(
    page.getByRole('button', { name: /^Memory kind:/ }),
    page.locator('.select-popover'),
    'Resized modal menu',
  );
  await audit('small-modal-menu-placement');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  // Demo pipeline supplies realistic plan, graph, handoff and activity surfaces.
  await page.goto(origin + '/#task/' + task.id + '/overview');
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.getByRole('radio', { name: 'Select Focused repair', exact: true }).waitFor();
  await audit('approach-approval');
  await page.getByRole('radio', { name: 'Select Focused repair', exact: true }).check();
  await page.getByRole('button', { name: 'Approve approach', exact: true }).click();
  await page.getByRole('button', { name: 'Accept result', exact: true }).waitFor();

  await page.goto(origin + '/#tasks');
  await page.getByRole('button', { name: /^Actions for Queue fixture 15$/ }).click();
  await audit('task-actions');
  await page.keyboard.press('Escape');
  assert.ok(
    await page
      .getByRole('button', { name: /^Actions for Queue fixture 15$/ })
      .evaluate((el) => el === document.activeElement),
  );
  await page.getByRole('button', { name: /^Actions for Queue fixture 15$/ }).click();
  await page.getByRole('button', { name: 'Delete task', exact: true }).click();
  await audit('delete-task-dialog');
  await page
    .getByRole('dialog', { name: 'Delete task?', exact: true })
    .getByRole('button', { name: 'Delete task', exact: true })
    .click();
  await until(
    async () => (await (await fetch(origin + '/api/tasks')).json()).length === 15,
    'delete fixture',
  );

  await page.goto(origin + '/#relay');
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await composer.fill('@Queue fixture 1');
  await anchored(composer, page.locator('.mention-suggestions'), 'Chat task mentions');
  await audit('chat-mentions');
  await composer.press('Escape');
  assert.equal(await page.getByRole('listbox', { name: 'Mention a task', exact: true }).count(), 0);
  assert.equal(await composer.inputValue(), '@Queue fixture 1');
  await composer.fill('@Queue fixture ');
  await composer.press('1');
  await page.getByRole('listbox', { name: 'Mention a task', exact: true }).waitFor();
  await composer.press('ArrowDown');
  await composer.press('Enter');
  assert.match(await composer.inputValue(), /#task\//);
  await composer.fill('First line');
  await composer.press('Shift+Enter');
  await composer.type('Second line');
  await composer.press('Enter');
  await page.getByText('Audit answer', { exact: true }).waitFor();
  assert.equal(
    await page.locator('.chat-user-message .prose br').count(),
    1,
    'Sent prompts retain line breaks',
  );
  await page.locator('.chat-scroll').evaluate((el) => {
    el.scrollTop = 0;
  });
  await audit('populated-chat');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page
    .locator('.chat-user-message')
    .getByRole('button', { name: 'Copy', exact: true })
    .click();
  await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    'First line\nSecond line',
  );
  await page.reload();
  await page.getByText('Audit answer', { exact: true }).waitFor();
  await page.locator('.chat-model-button').click();
  await page.getByRole('button', { name: /^Chat agent:/ }).click();
  await audit('chat-agent-settings');
  await page.getByRole('combobox', { name: 'Search Chat agent', exact: true }).press('Escape');
  const chatModel = page.getByRole('button', { name: /^claude model:/ });
  await chatModel.click();
  await page
    .getByRole('combobox', { name: 'Search claude model', exact: true })
    .fill('custom-model-'.repeat(24));
  await anchored(chatModel, page.locator('.select-popover'), 'Long custom model menu');
  assert.ok(
    await page.locator('.select-popover').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'Long model values stay inside their menu',
  );
  await audit('long-custom-model-menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.goto(origin + '/#task/' + task.id + '/overview');
  const ask = page.getByRole('button', { name: 'Ask Relay', exact: true });
  await ask.click();
  const resize = page.getByRole('button', { name: 'Resize Ask Relay', exact: true });
  const initial = await page.locator('.side-chat-window').boundingBox();
  await resize.press('ArrowLeft');
  assert.equal((await page.locator('.side-chat-window').boundingBox()).width, initial.width + 24);
  const launcherBox = await ask.boundingBox();
  const grip = await resize.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 30, grip.y + grip.height / 2 - 20, { steps: 5 });
  await page.mouse.up();
  const resized = await page.locator('.side-chat-window').boundingBox();
  assert.equal(resized.width, initial.width + 54, 'Pointer resize follows the grip');
  assert.equal(resized.height, initial.height + 20);
  assert.deepEqual(await ask.boundingBox(), launcherBox, 'Resizing leaves the launcher in place');
  await audit('side-chat-desktop');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Close Ask Relay', exact: true }).click();
  await page.goBack();
  await page.locator('.side-chat-window').waitFor();
  assert.match(page.url(), /ask=1/);
  await page.goForward();
  await page.locator('.side-chat-window').waitFor({ state: 'hidden' });
  await ask.click();
  await page.setViewportSize({ width: 320, height: 568 });
  const side = await page.locator('.side-chat-window').boundingBox();
  assert.ok(
    side.x >= 0 && side.y >= 0 && side.x + side.width <= 320 && side.y + side.height <= 568,
  );
  await audit('side-chat-small-screen');
  await page
    .getByRole('textbox', { name: 'Ask Relay about this task', exact: true })
    .press('Escape');
  await page.locator('.side-chat-window').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await audit('mobile-workspace-menu');
  await page
    .getByRole('navigation', { name: 'Mobile workspace', exact: true })
    .getByRole('button', { name: 'Repositories', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Repositories', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await audit('mobile-repository-dialog');
  await page.keyboard.press('Escape');
  await page.goto(origin + '/#relay');
  await page.getByText('Audit answer', { exact: true }).waitFor();
  const chatsToggle = page.getByRole('button', { name: 'Chats', exact: true });
  await chatsToggle.click();
  await audit('mobile-chat-list');
  await page.keyboard.press('Escape');
  assert.equal(await chatsToggle.getAttribute('aria-expanded'), 'false');
  assert.ok(await chatsToggle.evaluate((el) => el === document.activeElement));
  await chatsToggle.click();
  await page.mouse.click(310, 220);
  assert.equal(
    await chatsToggle.getAttribute('aria-expanded'),
    'false',
    'Clicking outside dismisses chat navigation',
  );
  await chatsToggle.click();
  await page.locator('.chat-list > div > button:first-child').first().click();
  assert.equal(
    await chatsToggle.getAttribute('aria-expanded'),
    'false',
    'Choosing a conversation closes the mobile list',
  );

  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await audit('landscape-task-dialog');
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    assert.ok(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      'Tab stays inside the modal',
    );
  }
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.ok(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      'Shift+Tab stays inside the modal',
    );
  }
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1512, height: 982 });

  // Populated decks must remain usable with a keyboard and nested pane layouts.
  await page.goto(origin + '/#deck');
  let picker = page.getByRole('combobox', { name: /Task for pane/ }).first();
  await picker.fill('Queue fixture 1');
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Queue fixture 1', { exact: true }) })
    .click();
  await audit('populated-deck');
  await picker.focus();
  await picker.fill('');
  await picker.press('Tab');
  assert.equal(await page.locator('.picker-popover').count(), 0, 'Tab dismisses the task picker');
  await picker.focus();
  await picker.fill('');
  for (let i = 0; i < 15; i++) await picker.press('ArrowDown');
  const activeOption = await picker.getAttribute('aria-activedescendant');
  assert.ok(
    await page.locator(`[id="${activeOption}"]`).evaluate((element) => {
      const list = element.closest('ul').getBoundingClientRect(),
        row = element.getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom + 1;
    }),
    'Keyboard selection remains visible',
  );
  await picker.press('Escape');
  await page.getByRole('button', { name: 'Split top and bottom', exact: true }).click();
  await page
    .getByRole('combobox', { name: /Task for pane/ })
    .nth(1)
    .fill('Queue fixture 1');
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Queue fixture 1', { exact: true }) })
    .click();
  await audit('split-deck');
  const lowerPicker = page.getByRole('combobox', { name: /Task for pane/ }).nth(1);
  await lowerPicker.click();
  await anchored(lowerPicker, page.locator('.picker-popover'), 'Lower pane task picker');
  await audit('lower-pane-task-picker');
  await lowerPicker.press('Escape');
  await page.getByRole('separator', { name: 'Resize panes', exact: true }).press('ArrowUp');
  await page.getByRole('button', { name: 'Focus', exact: true }).nth(1).click();
  await audit('focused-deck');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await audit('rename-workspace-dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Close tab', exact: true }).click();
  await audit('close-workspace-dialog');
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();

  // Use physical clicks: locator scrolling can move a horizontal board while opening a menu.
  await page.evaluate(() => localStorage.setItem('relay-low-motion', 'false'));
  await page.goto(origin + '/#tasks?view=board&scope=attention&empty=1');
  await page.reload();
  await page.locator('.task-board .task-card').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-low-motion'), 'false');
  const boardLeft = await page.locator('.task-board').evaluate((el) => el.scrollLeft);
  assert.ok(boardLeft > 0, 'Animated board opens at later populated stages');
  await pointerClick(page.locator('.task-board .card-menu'));
  const columnTrigger = page.getByRole('button', { name: /^Move to column:/ });
  await columnTrigger.waitFor();
  await pointerClick(columnTrigger);
  await anchored(columnTrigger, page.locator('.select-popover'), 'Animated board dropdown');
  assert.equal(
    await page.locator('.task-board').evaluate((el) => el.scrollLeft),
    boardLeft,
    'Opening menus preserves board position',
  );
  await audit('animated-board-menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const boardMenu = page.locator('.task-board .card-menu');
  await boardMenu.focus();
  await boardMenu.press('Enter');
  await columnTrigger.waitFor();
  await columnTrigger.press('ArrowDown');
  await anchored(columnTrigger, page.locator('.select-popover'), 'Keyboard board dropdown');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.setItem('relay-low-motion', 'true'));
  await page.reload();

  const routes = [
    'overview',
    'tasks?view=list',
    'tasks?view=board',
    'repositories',
    'settings',
    'agents',
    'storage',
    'memory',
    'inbox',
    'relay',
    'deck',
    ...['overview', 'thread', 'terminals', 'diff', 'handoffs', 'transcript'].map(
      (tab) => `task/${task.id}/${tab}`,
    ),
  ];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => localStorage.setItem('relay-theme', theme), theme);
    await page.reload();
    for (const width of [1512, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      for (const route of routes) {
        await page.goto(origin + '/#' + route);
        await page.locator('main h1').first().waitFor({ state: 'attached' });
        if (route === 'relay') await page.getByText('Audit answer', { exact: true }).waitFor();
        await audit(
          `${theme}-${width}-${route.replaceAll('/', '-')}`,
          width === 1512 || width === 390,
        );
      }
      console.log(`UI audit: ${theme}, ${width}px, ${screens.length} views`);
    }
  }
  // Exercise warning/error states without changing admission or real disk usage.
  const storageReport = await (await fetch(origin + '/api/storage/pressure')).json();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => localStorage.setItem('relay-theme', theme), theme);
    for (const state of ['warning', 'critical']) {
      const report = structuredClone(storageReport);
      report.pressure.state = state;
      report.pressure.message = 'Review available space before starting more work.';
      report.pressure.space.availableBytes = String(
        state === 'warning' ? 15 * 1024 ** 3 : 5 * 1024 ** 3,
      );
      await page.route('**/api/storage/pressure', (route) => route.fulfill({ json: report }));
      await page.goto(origin + '/#storage');
      await page.reload();
      await page.locator('.storage-' + state).waitFor();
      await audit(`${theme}-storage-${state}`);
      await page.unroute('**/api/storage/pressure');
    }
  }
  assert.deepEqual(errors, [], 'No browser exceptions');
  assert.deepEqual(requests, [], 'No failed local requests');
  if (artifacts)
    await writeFile(
      join(artifacts, 'report.json'),
      JSON.stringify({ screens, failures, errors, requests }, null, 2),
    );
  assert.deepEqual(failures, [], 'UI and accessibility regressions: ' + JSON.stringify(failures));
  console.log(
    `UI audit passed: ${screens.length} views, accessibility, keyboard, focus, scrolling and modal checks.`,
  );
} catch (error) {
  await capture('failure').catch(() => {});
  if (artifacts)
    await writeFile(
      join(artifacts, 'report.json'),
      JSON.stringify({ screens, failures, errors, requests, error: error.message }, null, 2),
    );
  console.error('UI audit server:', serverOutput);
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
  await rm(directory, { recursive: true, force: true });
}
