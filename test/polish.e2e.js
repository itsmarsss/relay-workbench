import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { demoHandoff } from '../server/harness.js';
import { mockDiscovery } from './discovery-fixtures.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-polish-'));
const app = createApp({
  directory,
  publicDirectory: resolve('public'),
  engineOptions: {
    workspaceAgentRun: async (_command, _args, options) => {
      options.onLine(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'workspace-answer',
            content: [{ type: 'text', text: 'Reading current task status…' }],
          },
        }),
        'stdout',
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      options.onLine(
        JSON.stringify({ type: 'result', result: 'Task status is **ready for review**.' }),
        'stdout',
      );
      return { code: 0, stdout: '', stderr: '' };
    },
  },
});
app.store.config.harnesses.claude = {
  command: process.execPath,
  enabled: true,
  model: 'test-model',
};
let browser;
try {
  const task = app.engine.create({ title: 'Test plan selection', demo: true });
  task.status = 'awaiting_plan';
  task.stage = 'plan';
  task.attempts = [
    { id: 'plan', stage: 'plan', status: 'complete', handoff: demoHandoff(task, 'plan') },
  ];
  app.store.save(task);
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
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(`${base}/#settings`);
  await page.locator('#low-motion').check();
  assert.equal(await page.evaluate(() => typeof window.Motion.animate), 'function');
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  assert.equal(await page.locator('html').getAttribute('data-low-motion'), '');
  await page.reload();
  assert.equal(await page.locator('#low-motion').isChecked(), true);
  await page.goto(`${base}/#tasks?q=Test&sort=title&layout=board`);
  await page.locator('#task-search').waitFor();
  assert.equal(await page.locator('#task-search').inputValue(), 'Test');
  await page.locator('#task-search').fill('plan');
  await page.reload();
  assert.equal(await page.locator('#task-search').inputValue(), 'plan');
  await page.goto(`${base}/#task/${task.id}/overview?chat=1`);
  await page.locator('.approach-option').nth(1).locator('.approach-description').click();
  assert.equal(await page.locator('#approach-1').isChecked(), true);
  const drawer = page.locator('.side-chat-drawer');
  await drawer.waitFor();
  const before = await drawer.boundingBox();
  const header = await page.locator('[data-chat-drag]').boundingBox();
  await page.mouse.move(header.x + 100, header.y + 20);
  await page.mouse.down();
  await page.mouse.move(header.x - 80, header.y + 80, { steps: 8 });
  await page.mouse.up();
  const moved = await drawer.boundingBox();
  assert.ok(moved.x < before.x - 100);
  assert.ok(moved.y >= 12 && moved.y + moved.height <= 988, 'drag stays inside viewport');
  const grip = await page.locator('.chat-resize').boundingBox();
  await page.mouse.move(grip.x + 10, grip.y + 10);
  await page.mouse.down();
  await page.mouse.move(grip.x + 90, grip.y - 90, { steps: 8 });
  await page.mouse.up();
  const resized = await drawer.boundingBox();
  assert.ok(resized.width > moved.width + 50);
  assert.ok(resized.height < moved.height - 50);
  await page.reload();
  await drawer.waitFor();
  assert.equal(Math.round((await drawer.boundingBox()).width), Math.round(resized.width));
  await page.goto(`${base}/#assistant`);
  await page.locator('#workspace-request').waitFor();
  await page.locator('#workspace-request').fill('Which tasks need attention?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Reading current task status…', { exact: true }).waitFor();
  await page
    .locator('.workspace-messages strong')
    .filter({ hasText: 'ready for review' })
    .waitFor();
  await page.reload();
  await page
    .locator('.workspace-messages strong')
    .filter({ hasText: 'ready for review' })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'docs/screenshots/workspace-agent-mobile.png', fullPage: true });
  console.log('Polish browser checks passed');
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
