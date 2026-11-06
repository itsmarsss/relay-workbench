import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { proposeMemories, listMemories } from '../server/memory.js';
import { assertReadableText } from './browser-contrast.js';
const { chromium } = await import('playwright');
const directory = await mkdtemp(join(tmpdir(), 'relay-memory-browser-'));
const app = createApp({
  directory,
  publicDirectory: resolve('public'),
  engineOptions: {
    demoDelay: 1,
    sideAnswer: async () => 'A separate answer with recorded context.',
  },
});
let browser;
try {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const task = app.engine.create({ title: 'Memory workflow', demo: true });
  proposeMemories(app.store, task, { id: 'example-run', harness: 'codex' }, [
    {
      title: 'A dated observation',
      scope: 'task',
      kind: 'observation',
      content: 'Recheck the local environment before relying on this observation.',
      evidence: 'Observed in an isolated test.',
      expiresAt: '2030-01-01T00:00:00Z',
    },
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#memory`);
  await page.getByRole('heading', { name: 'Memory', exact: true }).waitFor();
  await page.route('**/api/memories', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Endpoint not found' }),
    }),
  );
  await page.reload();
  await page.getByText('The memory backend update is waiting', { exact: false }).waitFor();
  await page.unroute('**/api/memories');
  await page.reload();
  await page.getByRole('heading', { name: 'A dated observation' }).waitFor();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Active', { exact: true }).waitFor();
  assert.equal(listMemories(app.store)[0].source.type, 'agent');
  await page.getByRole('button', { name: 'Add memory', exact: true }).click();
  const modal = page.locator('dialog');
  await modal.locator('#memory-title').fill('Concise updates');
  await modal
    .locator('#memory-content')
    .fill('Lead with the outcome. Keep routine progress updates concise.');
  await modal.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByRole('heading', { name: 'Concise updates' }).waitFor();
  const card = page
    .locator('.memory-card')
    .filter({ has: page.getByRole('heading', { name: 'Concise updates' }) });
  await card.getByRole('button', { name: 'Disable', exact: true }).click();
  await card.getByText('Disabled', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Enable', exact: true }).click();
  await card.getByText('Active', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await modal.locator('#memory-content').fill('Lead with the outcome and evidence.');
  await modal.getByRole('button', { name: 'Save memory', exact: true }).click();
  await card.getByText('Lead with the outcome and evidence.', { exact: true }).waitFor();
  await page.locator('#memory-search').fill('Concise');
  assert.equal(await page.locator('.memory-card').count(), 1);
  await page.locator('#memory-search').fill('');
  await page.reload();
  await page.getByRole('heading', { name: 'Concise updates' }).waitFor();
  assert.ok(page.url().endsWith('#memory'));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  assert.equal((await download).suggestedFilename(), 'relay-memories.json');
  await app.engine.action(task.id, 'start');
  for (let i = 0; i < 100 && app.store.get(task.id).status !== 'awaiting_plan'; i++)
    await new Promise((r) => setTimeout(r, 10));
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#task/${task.id}/overview`);
  await page.getByRole('button', { name: 'Ask on the side', exact: false }).click();
  await page.locator('#side-question').fill('What memories are you using?');
  await page.getByRole('button', { name: 'Ask without interrupting' }).click();
  await page.getByText('A separate answer with recorded context.', { exact: true }).waitFor();
  await page.getByText('Memory used by this answer', { exact: false }).click();
  await page
    .locator('.side-chat-drawer .memory-run-entry')
    .getByText('Lead with the outcome and evidence.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Close side conversation' }).click();
  await page.getByRole('button', { name: /View run history/ }).click();
  await page
    .locator('.memory-run-entry')
    .getByText('Lead with the outcome and evidence.', { exact: true })
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .locator('.task-memory-card')
    .getByRole('button', { name: 'Add memory', exact: true })
    .click();
  await modal.locator('#memory-title').fill('Task-only decision');
  await modal.locator('#memory-content').fill('Keep this decision scoped to this task.');
  await modal.getByRole('button', { name: 'Save memory', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  assert.equal(
    listMemories(app.store).find((m) => m.title === 'Task-only decision').targetId,
    task.id,
  );
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('heading', { name: 'Task-only decision' }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertReadableText(page);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({ path: `docs/screenshots/memory-${width}.png`, fullPage: true });
  }
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  await modal.getByRole('button', { name: 'Delete memory', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(
    listMemories(app.store).some((m) => m.title === 'Concise updates'),
    false,
  );
  assert.ok(
    app.store
      .get(task.id)
      .attempts[0].memorySnapshot.entries.some((m) => m.title === 'Concise updates'),
  );
  assert.deepEqual(errors, []);
  console.log(
    'Memory browser checks passed: approval, CRUD, scopes, reload, export, run snapshots, mobile layout and contrast.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
