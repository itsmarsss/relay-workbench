import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { mockDiscovery } from './discovery-fixtures.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-drag-'));
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  const first = app.engine.create({ title: 'Draggable task', demo: true });
  const other = app.engine.create({ title: 'Investigation task', demo: true });
  other.status = 'running';
  other.stage = 'investigate';
  app.store.save(other);
  const baseline = {
    status: first.status,
    stage: first.stage,
    approvals: structuredClone(first.approvals),
  };
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
  await page.goto(`${base}/#tasks`);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const card = page.locator(`.board-card[data-id="${first.id}"]`);
  const discovery = page.locator('.board-column[data-lane=discovery]');
  await card.dragTo(discovery, { targetPosition: { x: 140, y: 110 } });
  await discovery.locator(`.board-card[data-id="${first.id}"]`).waitFor();
  assert.equal(app.store.get(first.id).statusOverride.lane, 'discovery');
  assert.equal(new URL(page.url()).hash.split('?')[0], '#tasks', 'drop does not open a task');
  await page.reload();
  await discovery.locator(`.board-card[data-id="${first.id}"]`).waitFor();
  // Keyboard and touch share an explicit Move control with every board column.
  await card.focus();
  await page.keyboard.press('m');
  await page.locator('#board-move-lane').selectOption('final', { force: true });
  await page.getByRole('button', { name: 'Move task', exact: true }).click();
  await page.locator(`.column-final .board-card[data-id="${first.id}"]`).waitFor();
  assert.equal(app.store.get(first.id).statusOverride.lane, 'final');
  assert.equal(app.store.get(first.id).status, baseline.status);
  assert.equal(app.store.get(first.id).stage, baseline.stage);
  assert.deepEqual(app.store.get(first.id).approvals, baseline.approvals);
  // Failed saves retain the original card and surface an actionable error.
  await page.route('**/api/tasks/*/status-override', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Temporarily unavailable' }),
    }),
  );
  await page.getByRole('button', { name: 'Move task: Draggable task', exact: true }).click();
  await page.locator('#board-move-lane').selectOption('done', { force: true });
  await page.getByRole('button', { name: 'Move task', exact: true }).click();
  await page
    .locator('#toast')
    .getByText(/Couldn’t move task/)
    .waitFor();
  assert.equal(app.store.get(first.id).statusOverride.lane, 'final');
  assert.equal(await page.locator(`.column-final .board-card[data-id="${first.id}"]`).count(), 1);
  await page.unroute('**/api/tasks/*/status-override');
  // Hidden destinations appear while dragging; cancellation leaves no override.
  await card.scrollIntoViewIfNeeded();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer: transfer });
  await page.locator('.workflow-board.is-dragging').waitFor();
  assert.equal(await page.locator('.column-done').isVisible(), true);
  app.store.event(first.id, { type: 'activity', summary: 'Background update during drag' });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.workflow-board.is-dragging').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.workflow-board.is-dragging').count(), 0);
  assert.equal(app.store.get(first.id).statusOverride.lane, 'final');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: 'Move task: Draggable task', exact: true }).click();
  await page.locator('#board-move-lane').selectOption('approach', { force: true });
  await page.getByRole('button', { name: 'Move task', exact: true }).click();
  await page.locator(`.column-approach .board-card[data-id="${first.id}"]`).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Board dragging passed: native drag, persistent lane overrides, approvals preserved, keyboard/touch moves, failure recovery and drag cancellation during live refresh.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
