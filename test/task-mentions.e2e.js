import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { mockDiscovery } from './discovery-fixtures.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-mentions-ui-'));
const prompts = [];
const app = createApp({
  directory,
  publicDirectory: resolve('public'),
  engineOptions: {
    workspaceAgentRun: async (_cmd, _args, options) => {
      prompts.push(options.input);
      options.onLine(
        JSON.stringify({ type: 'result', result: 'I found the mentioned tasks.' }),
        'stdout',
      );
      return { code: 0, stderr: '' };
    },
  },
});
let browser;
try {
  app.store.setConfig({
    ...app.store.config,
    harnesses: {
      ...app.store.config.harnesses,
      claude: { ...app.store.config.harnesses.claude, enabled: true, command: process.execPath },
    },
  });
  const first = app.engine.create({ title: 'Repair empty results', demo: true });
  const second = app.engine.create({ title: 'Repair empty results', demo: true });
  const third = app.engine.create({ title: 'Validation boundary', demo: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#assistant');
  let input = page.locator('#workspace-request');
  await input.waitFor();
  await input.fill('Compare @Repair');
  await page.getByRole('listbox', { name: 'Tasks' }).waitFor();
  assert.equal(await page.getByRole('option').count(), 2);
  await input.press('ArrowDown');
  await input.press('Enter');
  assert.equal(prompts.length, 0);
  assert.match(await input.inputValue(), /Repair empty results · /);
  const selected = (await input.inputValue()).includes(first.id.slice(0, 8)) ? first : second;
  await input.press('End');
  await input.press('Space');
  await input.pressSequentially('@Validation');
  await page.getByRole('option', { name: /Validation boundary/ }).click();
  const draft = await input.inputValue();
  await page.reload();
  input = page.locator('#workspace-request');
  await input.waitFor();
  assert.equal(await input.inputValue(), draft);
  await input.press('Enter');
  await page.getByText('I found the mentioned tasks.', { exact: true }).waitFor();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], new RegExp(selected.id));
  assert.match(prompts[0], new RegExp(third.id));
  assert.equal(await page.locator('.side-chat-question .task-mention').count(), 2);
  await page.getByRole('button', { name: 'Edit prompt', exact: true }).click();
  const edit = page.locator('#chat-edit-question');
  await edit.evaluate((el) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await edit.pressSequentially(
    ' and @' + (selected.id === first.id ? second.id : first.id).slice(0, 8),
  );
  await page.getByRole('option').click();
  await page.getByRole('button', { name: 'Send revision', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () => document.querySelectorAll('.workspace-messages article').length === 2,
  );
  assert.equal(await page.locator('.side-chat-question .task-mention').count(), 5);
  assert.equal(prompts.length, 2);
  await page.reload();
  await page.locator('.task-mention').first().waitFor();
  assert.equal(await page.locator('.side-chat-question .task-mention').count(), 5);
  await page.locator('.task-mention').first().click();
  await page.getByRole('heading', { name: 'Repair empty results', exact: true }).waitFor();
  await page.locator('[data-action="open-orchestrator"]').first().click();
  input = page.locator('#relay-orchestrator #workspace-request');
  await input.fill('@no such task');
  await page.getByText('No matching tasks', { exact: true }).waitFor();
  await input.press('Escape');
  assert.equal(await page.locator('.task-mention-picker').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.RelayTheme.set('dark'));
  await input.fill('@Validation');
  await page.getByRole('option', { name: /Validation boundary/ }).waitFor();
  const bounds = await page.locator('.task-mention-picker').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  assert.ok(
    bounds.left >= 0 &&
      bounds.right <= bounds.width + 1 &&
      bounds.top >= 0 &&
      bounds.bottom <= bounds.height + 1,
    JSON.stringify(bounds),
  );
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/task-mentions-mobile.png' });
  await page.getByRole('option', { name: /Validation boundary/ }).click();
  assert.equal(prompts.length, 2);
  assert.deepEqual(errors, []);
  console.log(
    'Task mentions passed: search, duplicate titles, keyboard insertion, multiple references, persistent drafts/history, revisions, drawer, empty results and mobile dark layout.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
