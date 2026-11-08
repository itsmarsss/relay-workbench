import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { createMemory } from '../server/memory.js';
import { assertReadableText } from './browser-contrast.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-pages-'));
const app = createApp({ directory: join(directory, 'state'), publicDirectory: resolve('public') });
let browser;
try {
  const profile = {
    id: 'example',
    name: 'Example service',
    path: join(directory, 'repository-with-a-long-name'),
    cwd: '.',
    strategy: 'worktree',
    verificationMode: 'agent',
    checks: [],
    setup: [],
    instructions: '',
  };
  app.store.setConfig({ ...app.store.config, repositories: [profile] });
  const waiting = app.engine.create({ title: 'Choose a query validation approach', demo: true });
  Object.assign(waiting, { status: 'awaiting_plan', stage: 'plan', error: null });
  app.store.save(waiting);
  const active = app.engine.create({ title: 'Update the accepted change', demo: true });
  Object.assign(active, {
    status: 'completed',
    stage: 'review',
    deliveryRuns: [
      {
        id: 'followup',
        stage: 'followup',
        harness: 'codex',
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    ],
  });
  app.store.save(active);
  createMemory(app.store, {
    title: 'Prefer focused checks',
    content: 'Test changed behavior and directly affected callers.',
    scope: 'global',
    kind: 'preference',
    status: 'active',
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of [
      'overview',
      'tasks',
      'inbox',
      'repositories',
      'harnesses',
      'memory',
      'settings',
    ]) {
      await page.goto(`${base}/#${view}`);
      await page.locator('#main h1').waitFor();
      if (view === 'harnesses')
        await page.getByRole('heading', { name: 'Routing evidence', exact: true }).waitFor();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${view} fits ${width}`,
      );
      await assertReadableText(page);
      assert.equal(await page.locator('.nav-item[aria-current=page]').count(), 1);
      if (view === 'settings') {
        assert.equal(
          await page.locator('#main .settings-panel').first().getAttribute('id'),
          'settings-form',
        );
        await page.locator('.settings-disclosure').first().locator('summary').click();
        await assertReadableText(page);
        await page.locator('.settings-disclosure').first().locator('summary').click();
      }
      if (view === 'repositories') {
        await page.getByText('Agent discovers checks', { exact: true }).waitFor();
        assert.equal(await page.getByText('0 verification commands', { exact: false }).count(), 0);
      }
      if (process.env.RELAY_VISUAL_DIR) {
        await mkdir(process.env.RELAY_VISUAL_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.RELAY_VISUAL_DIR, `${view}-${width}.png`),
          fullPage: true,
        });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/#overview`);
  await page.locator('[data-action=overview-filter][data-filter=active]').click();
  assert.ok(page.url().endsWith('#tasks'));
  await page.getByText('Follow-up agent running', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-filter=active]').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.locator('#memory-search').fill('no-matching-preference');
  await page.getByRole('heading', { name: 'No matching memories', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await page.locator('#memory-search').inputValue(), '');
  await page.getByRole('heading', { name: 'Prefer focused checks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('heading', { name: 'Routing evidence', exact: true }).waitFor();
  await page.locator('#codex-command').fill('custom-codex');
  await page.locator('#pi-enabled').uncheck();
  await page.locator('#route-implement').selectOption('claude', { force: true });
  app.store.event(waiting.id, { type: 'activity', summary: 'A background update' });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#codex-command').inputValue(), 'custom-codex');
  assert.equal(await page.locator('#pi-enabled').isChecked(), false);
  assert.equal(await page.locator('#route-implement').inputValue(), 'claude');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#setting-recovery').fill('4');
  app.store.event(waiting.id, { type: 'activity', summary: 'Another background update' });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#setting-recovery').inputValue(), '4');
  assert.deepEqual(errors, []);
  console.log(
    'Workspace pages passed: responsive navigation, contrast, live follow-up filters, memory reset, repository mode, settings hierarchy, and draft preservation.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
