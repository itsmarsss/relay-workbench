import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { mockDiscovery } from './discovery-fixtures.js';
import { assertReadableText } from './browser-contrast.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-deck-'));
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  const one = app.engine.create({ title: 'First task', demo: true });
  const two = app.engine.create({ title: 'Second task', demo: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const mainResponse = await fetch(base + '/');
  assert.equal(mainResponse.headers.get('x-frame-options'), 'DENY');
  const embedResponse = await fetch(base + '/?embed=1');
  assert.equal(embedResponse.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(embedResponse.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#deck');
  await page.getByRole('heading', { name: 'Task deck' }).waitFor();
  await page.locator('[data-deck-task]').first().selectOption(one.id, { force: true });
  const firstFrame = page.frameLocator('.deck-frame').first();
  await firstFrame.locator('.task-title-row h1').waitFor({ state: 'attached' });
  assert.equal(await firstFrame.locator('.task-title-row h1').textContent(), 'First task');
  assert.equal(await page.locator('.deck-frame').count(), 1);
  await page.getByRole('button', { name: 'Split pane side by side' }).click();
  await page.locator('[data-deck-task]').nth(1).selectOption(two.id, { force: true });
  await page
    .frameLocator('.deck-frame')
    .nth(1)
    .locator('.task-title-row h1')
    .waitFor({ state: 'attached' });
  assert.equal(await page.locator('.deck-frame').count(), 2);
  await page
    .locator('.deck-pane')
    .first()
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector('.deck-frame')?.contentWindow.location.hash.endsWith('/thread'),
  );
  await firstFrame.locator('.detail-tabs [data-tab="terminals"]').click();
  await page
    .locator('.deck-pane')
    .first()
    .getByRole('button', { name: 'Terminal', exact: true, pressed: true })
    .waitFor();
  const divider = page.getByRole('separator', { name: 'Resize panes' });
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await divider.getAttribute('aria-valuenow'), '55');
  await page
    .frameLocator('.deck-frame')
    .first()
    .locator('body')
    .evaluate(() => {
      window.deckFocusMarker = 'preserved';
    });
  await page.locator('.deck-pane').first().getByRole('button', { name: 'Focus pane' }).click();
  assert.equal(await page.locator('.deck-frame').count(), 2);
  assert.equal(
    await page
      .frameLocator('.deck-frame')
      .first()
      .locator('body')
      .evaluate(() => window.deckFocusMarker),
    'preserved',
  );
  await page.getByRole('button', { name: 'Restore layout' }).click();
  assert.equal(await page.locator('.deck-frame').count(), 2);
  await page.reload();
  await page
    .frameLocator('.deck-frame')
    .nth(1)
    .locator('.task-title-row h1')
    .waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('separator').getAttribute('aria-valuenow'), '55');
  await page.getByRole('button', { name: 'Add workspace' }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.locator('#deck-name').fill('Investigation');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.getByRole('button', { name: 'Investigation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Workspace 1', exact: true }).click();
  assert.equal(await page.locator('.deck-frame').count(), 2);
  await page.evaluate(() => window.RelayTheme.set('dark'));
  await assertReadableText(page);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/task-deck.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log('Task deck browser checks passed.');
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
