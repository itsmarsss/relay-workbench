import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { createMemory } from '../server/memory.js';
import { mockDiscovery } from './discovery-fixtures.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-control-audit-'));
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  const task = app.engine.create({ title: 'Audit task controls', demo: true });
  createMemory(app.store, {
    scope: 'global',
    kind: 'preference',
    title: 'Explain affected behavior',
    content: 'Check the behavior that changed.',
    evidence: '**Evidence** with a readable source.',
    status: 'active',
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
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(`${base}/#memory`);
  await page.locator('.memory-toolbar').waitFor();
  const controls = await page.evaluate(() => {
    const toolbar = document.querySelector('.memory-toolbar');
    return [
      toolbar.querySelector('input'),
      toolbar.querySelector('relay-select').shadowRoot.querySelector('.select-trigger'),
      toolbar.querySelector('button'),
    ].map((node) => node.getBoundingClientRect().height);
  });
  assert.ok(
    controls.every((height) => Math.abs(height - 40) < 1),
    JSON.stringify(controls),
  );
  const padding = await page.locator('.memory-card .report-section').evaluate((node) => {
    const r = node.getBoundingClientRect(),
      s = node.querySelector('summary').getBoundingClientRect();
    return s.top - r.top;
  });
  assert.ok(padding <= 1.5, `disclosure top padding ${padding}`);
  const disclosure = page.locator('.memory-card .report-section');
  const collapsedHeight = await disclosure.evaluate((node) => node.getBoundingClientRect().height);
  await disclosure.locator('summary').click();
  await page.waitForTimeout(50);
  const expanding = await disclosure.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    full: node.scrollHeight,
    open: node.open,
  }));
  assert.equal(expanding.open, true);
  assert.ok(
    expanding.height > collapsedHeight && expanding.height < expanding.full,
    'disclosure grows through intermediate heights',
  );
  await page.waitForFunction(
    () => !document.querySelector('.memory-card .report-section').style.height,
  );
  await disclosure.locator('summary').click();
  assert.equal(
    await disclosure.evaluate((node) => node.open),
    true,
    'closing content stays visible during transition',
  );
  await page.waitForFunction(() => !document.querySelector('.memory-card .report-section').open);
  const newTask = page.getByRole('button', { name: 'New task', exact: true });
  assert.equal(await newTask.locator('kbd').textContent(), 'N');
  await page.goto(`${base}/#settings`);
  await page.locator('#low-motion').waitFor();
  assert.equal(
    await page.locator('#low-motion').evaluate((node) => getComputedStyle(node).appearance),
    'none',
  );
  await page.locator('#low-motion').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#low-motion').isChecked(), true);
  await page.locator('#low-motion').uncheck();
  await page.getByRole('button', { name: 'Open Relay orchestrator', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Relay orchestrator', exact: true });
  await dialog.waitFor();
  assert.ok(
    await dialog.evaluate((node) => node.getAnimations().length > 0),
    'orchestrator uses Motion animation',
  );
  await dialog.getByRole('button', { name: 'Prioritize', exact: false }).click();
  assert.match(await dialog.locator('#workspace-request').inputValue(), /prioritize/);
  await dialog.locator('#workspace-request').fill('Keep this draft while checking another task');
  await page.getByRole('button', { name: 'Close Relay orchestrator', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  assert.equal(
    await dialog.locator('#workspace-request').inputValue(),
    'Keep this draft while checking another task',
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.goto(`${base}/#task/${task.id}/overview?chat=1`);
  const drawer = page.locator('.side-chat-drawer');
  await drawer.waitFor();
  await page.waitForTimeout(300);
  const composerAlignment = await page.evaluate(() => {
    const box = document.querySelector('.side-chat-drawer textarea').getBoundingClientRect();
    const ask = document.querySelector('.side-chat-compose-footer button').getBoundingClientRect();
    const grip = document.querySelector('.chat-resize').getBoundingClientRect();
    return { right: Math.abs(box.right - ask.right), gap: grip.top - ask.bottom };
  });
  assert.ok(composerAlignment.right < 1, 'Ask aligns with the input independently of the grip');
  assert.ok(composerAlignment.gap >= 0, 'resize grip does not overlap Ask');
  const drawerIdentity = await drawer.elementHandle();
  const tabMotion = await page.evaluate(() => {
    document.querySelector('[data-action="tab"][data-tab="thread"]').click();
    return document.querySelector('.detail-content').getAnimations().length;
  });
  assert.ok(tabMotion > 0, 'task tab content transitions');
  assert.ok(
    await drawerIdentity.evaluate((node) => node === document.querySelector('.side-chat-drawer')),
    'switching tabs preserves the chat window and its position',
  );

  const start = await drawer.boundingBox();
  const grip = await page.locator('.chat-resize').boundingBox();
  await page.mouse.move(grip.x + 12, grip.y + 12);
  await page.mouse.down();
  await page.mouse.move(grip.x + 180, grip.y + 100, { steps: 6 });
  await page.mouse.up();
  const blocked = await drawer.boundingBox();
  assert.equal(Math.round(blocked.x), Math.round(start.x));
  assert.equal(Math.round(blocked.y), Math.round(start.y));
  const west = await page.locator('.chat-edge-w').boundingBox();
  await page.mouse.move(west.x + 3, west.y + 60);
  await page.mouse.down();
  await page.mouse.move(west.x - 100, west.y + 60, { steps: 6 });
  await page.mouse.up();
  const expanded = await drawer.boundingBox();
  assert.ok(
    expanded.width > blocked.width + 80,
    JSON.stringify({
      start,
      blocked,
      west,
      expanded,
      geometry: await page.evaluate(() => localStorage.getItem('relay-chat-window')),
    }),
  );
  assert.ok(Math.abs(expanded.x + expanded.width - blocked.x - blocked.width) < 1);
  await page.goto(`${base}/#assistant`);
  await page.locator('.orchestrator-intro').waitFor();
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/orchestrator-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'docs/screenshots/orchestrator-mobile.png', fullPage: true });
  await page.goto(`${base}/#settings`);
  await page.locator('#low-motion').check();
  await page.getByRole('button', { name: 'Open Relay orchestrator', exact: true }).click();
  await dialog.waitFor();
  assert.equal(await dialog.evaluate((node) => node.getAnimations().length), 0);
  const sendBounds = await dialog.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  assert.ok(sendBounds.y + sendBounds.height <= 844, 'orchestrator composer stays visible');
  await page.screenshot({ path: 'docs/screenshots/orchestrator-panel-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'Control audit passed: sizing, disclosures, custom controls, anchored resizing, global orchestrator, motion and low motion.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
