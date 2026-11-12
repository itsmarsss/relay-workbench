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
  // Dialogs and drawers animate into place; measure them where they come to rest.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
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
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ name: 'detected-service', scripts: { test: 'exit 91' } }),
  );
  await writeFile(join(fixture, 'package-lock.json'), '{}');
  await writeFile(join(fixture, 'AGENTS.md'), 'Fixture guidance');
  await mkdir(join(fixture, 'packages', 'api'), { recursive: true });
  await writeFile(
    join(fixture, 'packages', 'api', 'package.json'),
    JSON.stringify({ name: 'detected-api', scripts: { test: 'exit 92' } }),
  );
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
  // Leave too little room under the field for even this short list, so it has to open upward.
  const providerField = await reviewProvider.boundingBox();
  await page.setViewportSize({
    width: 1512,
    height: Math.round(providerField.y + providerField.height + 80),
  });
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
  await page.setViewportSize({ width: 1512, height: 982 });
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
  await page.getByRole('textbox', { name: 'Search folder', exact: true }).fill(fixture);
  await page.getByRole('button', { name: 'Scan folder', exact: true }).click();
  await page.getByText('Scanned folders (1)', { exact: true }).waitFor();
  assert.equal(await page.locator('.discovered-repositories > li').count(), 1);
  assert.ok(
    await page.locator('.discovered-repositories').getByText('Added', { exact: true }).isVisible(),
  );
  await audit('repository-discovery');
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add repository', exact: true });
  await dialog.getByRole('tab', { name: 'General', exact: true }).press('ArrowRight');
  await dialog.getByRole('tab', { name: 'General', exact: true }).press('End');
  await dialog.getByRole('tab', { name: 'Guidance', exact: true }).press('Home');
  await dialog.getByRole('tab', { name: 'General', exact: true }).press('ArrowRight');
  assert.ok(await dialog.getByRole('radio', { name: 'New worktree', exact: true }).isChecked());
  await dialog.getByRole('tab', { name: 'Guidance', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save repository', exact: true }).click();
  await dialog
    .getByText('Enter a name, repository path and working directory.', { exact: true })
    .waitFor();
  assert.equal(
    await dialog.getByRole('tab', { name: 'General', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await dialog.getByRole('textbox', { name: 'Repository path', exact: true }).fill(fixture);
  await dialog.getByText('Use package api', { exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    'detected-service',
  );
  await dialog
    .locator('.profile-detected-fields li')
    .filter({ has: page.getByText('Use package api', { exact: true }) })
    .getByRole('button', { name: 'Use', exact: true })
    .click();
  assert.equal(
    await dialog.getByRole('textbox', { name: 'Working subdirectory', exact: true }).inputValue(),
    'packages/api',
  );
  await dialog.getByText('Package name', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Add check', exact: true }).click();
  assert.ok(
    await dialog.getByRole('radio', { name: 'Required commands', exact: true }).isChecked(),
  );
  await audit('repository-detected-checks');
  const setupCommands = dialog
    .locator('.command-list-editor')
    .filter({ has: page.getByRole('heading', { name: 'Setup commands', exact: true }) });
  await setupCommands.getByRole('button', { name: 'Add command', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Guidance', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save repository', exact: true }).click();
  await dialog
    .getByText('Setup commands need an executable and a list of literal arguments.', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole('tab', { name: 'Checks & setup', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  await setupCommands.getByRole('button', { name: 'Remove command', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Guidance', exact: true }).click();
  await dialog
    .getByRole('textbox', { name: 'Repository instructions', exact: true })
    .fill('**Repository guidance**');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  assert.equal(
    await dialog.locator('.markdown-preview strong').textContent(),
    'Repository guidance',
  );
  await dialog.getByRole('button', { name: 'Save repository', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const addedProfile = page
    .locator('.repository-card')
    .filter({ has: page.getByRole('heading', { name: 'detected-service', exact: true }) });
  await addedProfile.getByText('1 configured commands', { exact: true }).waitFor();
  await addedProfile.getByRole('button', { name: 'Edit profile', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit repository', exact: true });
  await dialog.getByRole('tab', { name: 'Guidance', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove profile', exact: true }).click();
  assert.ok(
    await dialog
      .getByRole('button', { name: 'Keep profile', exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await audit('repository-removal-confirmation');
  await dialog.getByRole('button', { name: 'Keep profile', exact: true }).click();
  assert.ok(
    await dialog
      .getByRole('button', { name: 'Remove profile', exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await dialog.getByRole('button', { name: 'Remove profile', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await addedProfile.count(), 0);
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
  const dock = page.locator('.ask-dock');
  // The dock slides in from the right; it has settled once it rests on the window's edge.
  const docked = () =>
    until(
      () => dock.evaluate((el) => Math.abs(el.getBoundingClientRect().right - innerWidth) < 1),
      'Ask Relay finishes opening',
    );
  await docked();
  await page.getByRole('textbox', { name: 'Ask Relay about this task', exact: true }).waitFor();
  assert.ok(
    await page
      .getByRole('textbox', { name: 'Ask Relay about this task', exact: true })
      .evaluate((el) => el === document.activeElement),
    'Opening Ask Relay moves focus to its composer',
  );
  const resize = page.getByRole('separator', { name: 'Resize Ask Relay', exact: true });
  const initial = await dock.boundingBox();
  assert.equal(initial.x + initial.width, 1512, 'Ask Relay docks to the right edge');
  assert.equal(initial.height, 982, 'Ask Relay runs the full height');
  const beside = async () => {
    const shell = await page.locator('.main-shell').boundingBox(),
      box = await dock.boundingBox();
    return Math.abs(shell.x + shell.width - box.x) <= 1;
  };
  assert.ok(await beside(), 'The page sits beside Ask Relay, not under it');
  await resize.press('ArrowLeft');
  assert.equal((await dock.boundingBox()).width, initial.width + 24);
  const grip = await resize.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 30, grip.y + 180, { steps: 5 });
  await page.mouse.up();
  const resized = await dock.boundingBox();
  assert.equal(resized.width, initial.width + 54, 'Pointer resize follows the grip');
  assert.equal(resized.height, initial.height, 'Resizing changes the width only');
  assert.ok(await beside(), 'The page gives up the room Ask Relay takes');
  await audit('side-chat-desktop');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Close Ask Relay', exact: true }).click();
  await dock.waitFor({ state: 'hidden' });
  assert.ok(
    await ask.evaluate((el) => el === document.activeElement),
    'Closing Ask Relay returns focus to its button',
  );
  await page.reload();
  await page.locator('.task-page-heading').waitFor();
  await ask.click();
  await docked();
  assert.equal(
    (await dock.boundingBox()).width,
    resized.width,
    'Ask Relay keeps its width across reloads',
  );
  await page.getByRole('button', { name: 'Close Ask Relay', exact: true }).click();
  await page.goBack();
  await dock.waitFor();
  assert.match(page.url(), /ask=1/);
  await page.goForward();
  await dock.waitFor({ state: 'hidden' });
  await ask.click();
  await page.setViewportSize({ width: 320, height: 568 });
  await docked();
  const side = await dock.boundingBox();
  assert.ok(
    side.x >= 0 && side.y >= 0 && side.x + side.width <= 320 && side.y + side.height <= 568,
  );
  await audit('side-chat-small-screen');
  await page
    .getByRole('textbox', { name: 'Ask Relay about this task', exact: true })
    .press('Escape');
  await dock.waitFor({ state: 'hidden' });
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
  // A live deck fills itself; nothing has to be added by hand.
  const deckMode = page.getByRole('group', { name: 'Deck contents', exact: true });
  await page.locator('.deck-group .monitor-tile').first().waitFor();
  assert.equal(
    await deckMode.getByRole('button', { name: 'Live', exact: true }).getAttribute('aria-pressed'),
    'true',
    'A new deck starts live',
  );
  assert.equal(
    await page.getByRole('combobox', { name: 'Add task to grid', exact: true }).count(),
    0,
    'A live deck has no manual picker',
  );
  await audit('live-deck');
  await page.locator('.deck-group .monitor-task-title').first().click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await deckMode.getByRole('button', { name: 'Pinned', exact: true }).click();
  await page.getByRole('button', { name: 'Edit grid', exact: true }).waitFor();
  assert.ok(
    (await page.locator('.deck-monitor-grid .monitor-tile').count()) > 0,
    'Pinning starts from the tasks already on screen',
  );
  await deckMode.getByRole('button', { name: 'Live', exact: true }).click();
  await page.locator('.deck-group').first().waitFor();
  // The manual grid below starts from an empty pinned workspace.
  await page.evaluate(() => {
    const tab = crypto.randomUUID();
    localStorage.setItem(
      'relay-react-deck-v1',
      JSON.stringify({
        active: tab,
        tabs: [
          {
            id: tab,
            name: 'Workspace 1',
            root: { type: 'pane', id: crypto.randomUUID(), taskId: '', view: 'overview' },
            layout: 'grid',
            columns: 3,
            density: 'auto',
            mode: 'pinned',
          },
        ],
      }),
    );
  });
  await page.reload();
  await page.getByText('Add tasks to monitor.', { exact: true }).waitFor();
  assert.equal(
    await page.locator('.monitor-tile').count(),
    0,
    'Empty monitor has no placeholder panels',
  );
  await audit('empty-task-grid');
  let picker = page.getByRole('combobox', { name: 'Add task to grid', exact: true });
  await picker.fill('Queue fixture 1');
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Queue fixture 1', { exact: true }) })
    .click();
  await audit('populated-deck');
  assert.equal(
    await page.getByRole('combobox', { name: /Task for pane/ }).count(),
    0,
    'Monitoring hides replacement fields',
  );
  assert.ok(
    (await page.locator('.monitor-tile').boundingBox()).height <= 132,
    'Monitoring tile fits in 132 pixels',
  );
  await page.getByRole('button', { name: 'Queue fixture 1', exact: true }).click();
  let detail = page.getByRole('dialog', { name: 'Queue fixture 1', exact: true });
  await detail.waitFor();
  await audit('expanded-monitor-task');
  await detail.getByRole('button', { name: 'Terminal', exact: true }).click();
  await audit('expanded-monitor-terminal');
  await page.keyboard.press('Escape');
  assert.ok(
    await page
      .getByRole('button', { name: 'Queue fixture 1', exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  const addTask = page.getByRole('combobox', { name: 'Add task to grid', exact: true });
  await addTask.fill('Queue fixture 2');
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Queue fixture 2', { exact: true }) })
    .click();
  assert.equal(await page.locator('.deck-monitor-grid .monitor-tile').count(), 2);
  await page.getByRole('button', { name: 'Edit grid', exact: true }).click();
  await page.getByRole('button', { name: '3 columns', exact: true }).click();
  await page.reload();
  await page.locator('.deck-monitor-grid[data-columns="3"] .monitor-tile').first().waitFor();
  await page.getByRole('button', { name: 'Edit grid', exact: true }).click();
  assert.deepEqual(
    await page
      .getByRole('combobox', { name: /Task for pane/ })
      .evaluateAll((els) => els.map((el) => el.value)),
    ['Queue fixture 1', 'Queue fixture 2'],
  );
  await page
    .getByRole('button', { name: 'Reorder pane 1', exact: true })
    .dragTo(page.locator('.deck-monitor-grid .monitor-tile').nth(1));
  assert.deepEqual(
    await page
      .getByRole('combobox', { name: /Task for pane/ })
      .evaluateAll((els) => els.map((el) => el.value)),
    ['Queue fixture 2', 'Queue fixture 1'],
  );
  await page.getByRole('button', { name: 'Reorder pane 1', exact: true }).press('ArrowRight');
  assert.deepEqual(
    await page
      .getByRole('combobox', { name: /Task for pane/ })
      .evaluateAll((els) => els.map((el) => el.value)),
    ['Queue fixture 1', 'Queue fixture 2'],
  );
  await audit('editable-task-grid');
  await page.getByRole('button', { name: '1 column', exact: true }).click();
  await audit('one-column-task-grid');
  await page.setViewportSize({ width: 390, height: 844 });
  await audit('mobile-task-grid');
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.getByRole('button', { name: 'Close pane', exact: true }).nth(1).click();
  await page.getByRole('button', { name: '2 columns', exact: true }).click();
  picker = page.getByRole('combobox', { name: /Task for pane/ }).first();
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
      const list = element.closest('[role="listbox"]').getBoundingClientRect(),
        row = element.getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom + 1;
    }),
    'Keyboard selection remains visible',
  );
  await picker.press('Escape');
  await page.getByRole('button', { name: 'Freeform', exact: true }).click();
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

  // Eight watched tasks must fit as monitoring tiles, with a single page scroll.
  await page.getByRole('button', { name: 'Auto fit', exact: true }).click();
  for (let i = 2; i <= 7; i++) {
    const add = page.getByRole('combobox', { name: 'Add task to grid', exact: true });
    await add.fill('Queue fixture ' + i);
    await page
      .getByRole('option')
      .filter({ has: page.getByText('Queue fixture ' + i, { exact: true }) })
      .click();
  }
  await page.getByRole('button', { name: 'Done editing', exact: true }).click();
  assert.equal(await page.locator('.monitor-tile').count(), 8);
  const realTasks = await (await fetch(origin + '/api/tasks')).json();
  const startedAt = new Date(Date.now() - 65000).toISOString();
  await page.route('**/api/tasks', (route) =>
    route.fulfill({
      json: realTasks.map((task) =>
        /^Queue fixture [1-7]$/.test(task.title)
          ? {
              ...task,
              status: 'running',
              stage: 'implement',
              currentRun: {
                id: 'monitor-fixture',
                stage: 'implement',
                harness: 'codex',
                status: 'running',
                startedAt,
              },
              latestSummary: 'Focused checks pass. Finishing the selected implementation.',
            }
          : task,
      ),
    }),
  );
  await page.reload();
  const counter = page.locator('.monitor-time[data-live="true"]').first();
  await counter.waitFor();
  const initialCounter = Number(await counter.getAttribute('data-seconds'));
  await until(
    async () => Number(await counter.getAttribute('data-seconds')) > initialCounter,
    'Run counter advances without refresh',
  );
  for (const [width, theme] of [
    [1512, 'light'],
    [1512, 'dark'],
    [390, 'dark'],
  ]) {
    await page.evaluate((theme) => localStorage.setItem('relay-theme', theme), theme);
    await page.reload();
    await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
    await page.locator('.monitor-tile').nth(7).waitFor();
    assert.ok(
      await page
        .locator('.monitor-tile')
        .evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height <= 132)),
      'Status tiles stay under 132px',
    );
    const nestedScroll = await page.locator('main').evaluate((main) =>
      [...main.querySelectorAll('*')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return (
            (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
            (/auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1)
          );
        })
        .map((el) => el.className),
    );
    assert.deepEqual(nestedScroll, [], 'Monitoring has no nested scroll panes');
    await audit(`dense-monitor-${theme}-${width}`);
  }
  await page.unroute('**/api/tasks');
  // Deleted tasks leave reusable grid slots, including a previously full grid.
  await page.route('**/api/tasks', (route) =>
    route.fulfill({ json: realTasks.filter((task) => task.title !== 'Queue fixture 7') }),
  );
  await page.reload();
  await until(
    async () => (await page.locator('.monitor-tile').count()) === 7,
    'Deleted task hidden',
  );
  const replacement = page.getByRole('combobox', { name: 'Add task to grid', exact: true });
  await replacement.fill('Queue fixture 8');
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Queue fixture 8', { exact: true }) })
    .click();
  assert.equal(await page.locator('.monitor-tile').count(), 8, 'Deleted slot can be reused');
  await page.getByRole('button', { name: 'Queue fixture 8', exact: true }).waitFor();
  await page.unroute('**/api/tasks');
  await page.evaluate(() => localStorage.setItem('relay-theme', 'light'));
  await page.setViewportSize({ width: 1512, height: 982 });

  // Empty workspaces retain a usable create action even with empty stages hidden.
  await page.route('**/api/tasks', (route) => route.fulfill({ json: [] }));
  await page.goto(origin + '/#tasks?view=board&empty=0');
  await page.reload();
  await page.getByRole('button', { name: 'Create task', exact: true }).waitFor();
  assert.equal(await page.locator('.task-lane').count(), 11);
  assert.equal(await page.getByText('No matching tasks', { exact: true }).count(), 0);
  await audit('empty-task-board');
  await page.unroute('**/api/tasks');

  // Real wheel input over cards scrolls the page at every responsive board width.
  await page.reload();
  for (const width of [1512, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
    await page.locator('.task-board .task-card').first().waitFor();
    await page.locator('main').evaluate((el) => {
      el.scrollTop = 0;
    });
    const firstCard = await page.locator('.task-board .task-card').first().boundingBox();
    await page.mouse.move(firstCard.x + firstCard.width / 2, firstCard.y + firstCard.height / 2);
    await page.mouse.wheel(0, 400);
    await until(
      async () => (await page.locator('main').evaluate((el) => el.scrollTop)) > 100,
      'Wheel over cards scrolls the page at ' + width,
    );
    assert.deepEqual(
      await page.locator('.task-board').evaluate((board) =>
        [board, ...board.querySelectorAll('*')]
          .filter((el) => {
            const style = getComputedStyle(el);
            return (
              (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
              (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1)
            );
          })
          .map((el) => el.className),
      ),
      [],
      'Board has no nested scroll containers at ' + width,
    );
    await audit('single-scroll-board-' + width);
  }
  await page.setViewportSize({ width: 1512, height: 982 });

  // Physical clicks verify menus on wrapped stages preserve the page position.
  await page.evaluate(() => localStorage.setItem('relay-low-motion', 'false'));
  await page.goto(origin + '/#tasks?view=board&scope=attention&empty=1');
  await page.reload();
  await page.locator('.task-board .task-card').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-low-motion'), 'false');
  const boardLeft = await page.locator('.task-board').evaluate((el) => el.scrollLeft);
  assert.equal(boardLeft, 0, 'Board never scrolls sideways');
  assert.ok(
    await page
      .locator('.task-board')
      .evaluate(
        (el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
      ),
    'Board has no nested scroll surface',
  );
  await page.locator('.task-board .card-menu').scrollIntoViewIfNeeded();
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
