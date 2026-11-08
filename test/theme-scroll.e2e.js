import { assertReadableText } from './browser-contrast.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { mockDiscovery } from './discovery-fixtures.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-theme-scroll-'));
const seed = new Store(directory);
const history = Array.from({ length: 35 }, (_, index) => ({
  id: `saved-${index}`,
  question: `Question ${index}`,
  answer: 'A detailed response.\n\n' + 'More context. '.repeat(35),
  status: 'complete',
}));
seed.db
  .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
  .run('workspace-agent', JSON.stringify(history));
seed.close();
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  const task = app.engine.create({ title: 'Scroll containment', demo: true });
  for (let index = 0; index < 80; index++)
    app.store.event(task.id, {
      type: 'feedback',
      summary: `Activity ${index}: meaningful task context`,
      details: 'Longer detail. '.repeat(15),
    });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/#assistant`);
  await page.locator('.workspace-messages article').first().waitFor();
  async function contained() {
    const result = await page.evaluate(() => {
      const messages = document.querySelector('.workspace-messages');
      const composer = document.querySelector('#workspace-agent-form').getBoundingClientRect();
      return {
        pageHeight: document.documentElement.scrollHeight,
        viewport: innerHeight,
        composerBottom: composer.bottom,
        overflowing: messages.scrollHeight > messages.clientHeight,
        overscroll: getComputedStyle(messages).overscrollBehaviorY,
      };
    });
    assert.ok(result.pageHeight <= result.viewport + 1, JSON.stringify(result));
    assert.ok(result.composerBottom <= result.viewport, JSON.stringify(result));
    assert.ok(result.overflowing);
    assert.equal(result.overscroll, 'contain');
  }
  await contained();
  const sent = [];
  await page.route('**/api/workspace-agent', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON().question);
    await route.fulfill({ json: { ok: true } });
  });
  const workspaceInput = page.locator('#workspace-request');
  await workspaceInput.fill('First line');
  await workspaceInput.press('Shift+Enter');
  await workspaceInput.press('a');
  assert.equal(await workspaceInput.inputValue(), 'First line\na');
  assert.deepEqual(sent, []);
  await workspaceInput.press('Enter');
  await page.waitForFunction(() => document.querySelector('#workspace-request').value === '');
  assert.deepEqual(sent, ['First line\na']);
  await page.unroute('**/api/workspace-agent');
  await page.locator('#workspace-request').fill('Keep this unsent draft');
  await page.reload();
  await page.locator('.workspace-messages article').first().waitFor();
  assert.equal(await page.locator('#workspace-request').inputValue(), 'Keep this unsent draft');
  await page.locator('.workspace-messages').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.workspace-messages').evaluate((node) => node.scrollTop), 0);
  await page.goto(`${base}/#settings`);
  await page.locator('#theme-preference').waitFor({ state: 'attached' });
  await page.locator('#theme-preference').evaluate((node) => {
    node.value = 'dark';
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('#theme-preference').waitFor({ state: 'attached' });
  const select = page.locator('relay-select').filter({ has: page.locator('#theme-preference') });
  await select.locator('.select-trigger').click();
  const dropdown = select.locator('.select-popover');
  assert.ok(
    await dropdown.evaluate((node) => node.getAnimations().length > 0),
    'dropdown entrance uses Motion',
  );
  const dropdownColor = await dropdown.evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.notEqual(dropdownColor, 'rgb(255, 255, 255)');
  await page.keyboard.press('Escape');
  await page.goto(`${base}/#assistant`);
  await page.locator('.workspace-messages article').first().waitFor();
  await contained();
  await mkdir('docs/screenshots', { recursive: true });
  await page.waitForTimeout(300);
  await assertReadableText(page);
  await page.screenshot({ path: 'docs/screenshots/relay-dark-desktop.png', fullPage: true });
  const sidebarStart = await page
    .locator('.sidebar')
    .evaluate((node) => node.getBoundingClientRect().width);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.waitForTimeout(50);
  const sidebarMiddle = await page
    .locator('.sidebar')
    .evaluate((node) => node.getBoundingClientRect().width);
  assert.ok(
    sidebarMiddle < sidebarStart && sidebarMiddle > 64,
    `Sidebar interpolates width: ${sidebarStart} -> ${sidebarMiddle}`,
  );
  await page.waitForTimeout(300);
  await contained();
  await page.goto(`${base}/#task/${task.id}/thread`);
  await page.locator('[data-action="activity-run"][data-run="all"]').click();
  const activity = await page.locator('.activity-run-content .timeline').evaluate((node) => ({
    height: node.clientHeight,
    content: node.scrollHeight,
    overscroll: getComputedStyle(node).overscrollBehaviorY,
  }));
  assert.ok(activity.content > activity.height && activity.height > 100, JSON.stringify(activity));
  assert.equal(activity.overscroll, 'contain');
  await page.waitForTimeout(300);
  await assertReadableText(page);
  await page.screenshot({ path: 'docs/screenshots/activity-dark-desktop.png', fullPage: true });
  for (const view of ['overview', 'tasks', 'repositories', 'harnesses', 'memory', 'settings']) {
    await page.goto(`${base}/#${view}`);
    await page.locator('main h1').waitFor();
    await page.waitForTimeout(300);
    try {
      await assertReadableText(page);
    } catch (error) {
      console.error('Dark page:', view);
      throw error;
    }
  }
  await page.goto(`${base}/#task/${task.id}/overview?chat=1`);
  const sideSent = [];
  await page.route(`**/api/tasks/${task.id}/question`, async (route) => {
    sideSent.push(route.request().postDataJSON().question);
    await route.fulfill({ json: { ok: true } });
  });
  const sideInput = page.locator('#side-question');
  await sideInput.fill('Explain');
  await sideInput.press('Shift+Enter');
  await sideInput.press('b');
  assert.equal(await sideInput.inputValue(), 'Explain\nb');
  await sideInput.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.deepEqual(sideSent, []);
  await sideInput.press('Enter');
  await page.waitForFunction(() => document.querySelector('#side-question').value === '');
  assert.deepEqual(sideSent, ['Explain\nb']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#assistant`);
  await page.locator('.workspace-messages article').first().waitFor();
  await contained();
  await page.screenshot({ path: 'docs/screenshots/relay-dark-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'Theme and scroll checks passed: persisted chat and theme, contained conversations/activity, anchored composer, dropdown and sidebar Motion, mobile layout.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
