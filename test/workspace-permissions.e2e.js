import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { proposeConfiguration, configurationProposals } from '../server/workspace-permissions.js';
import { proposeTaskChanges } from '../server/task-proposals.js';
import { mockDiscovery } from './discovery-fixtures.js';
import { assertReadableText } from './browser-contrast.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-workspace-permission-ui-'));
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  app.store.setConfig({
    ...app.store.config,
    harnesses: {
      ...app.store.config.harnesses,
      claude: { ...app.store.config.harnesses.claude, model: 'baseline-model' },
    },
  });
  proposeConfiguration(
    app.store,
    [{ path: ['concurrency'], value: 3 }],
    'Allow independent tasks to run together',
  );
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
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
  await page.getByRole('button', { name: 'Relay model and permissions' }).waitFor();
  assert.match(await page.locator('.relay-model-button').innerText(), /baseline-model/);
  assert.ok((await page.locator('.orchestrator-intro').boundingBox()).height <= 36);
  await page.getByRole('button', { name: 'Relay model and permissions' }).click();
  const dialog = page.locator('#dialog');
  await dialog.locator('#workspace-agent-model').evaluate((node) => {
    node.add(new Option('chosen-model', 'chosen-model'));
    node.value = 'chosen-model';
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await dialog.locator('#workspace-agent-effort').selectOption('high', { force: true });
  await dialog.getByRole('checkbox', { name: 'Read approved memory' }).uncheck();
  await dialog.getByRole('button', { name: 'Save Relay settings' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(app.store.config.workspaceAgent.model, 'chosen-model');
  assert.equal(app.store.config.workspaceAgent.effort, 'high');
  assert.equal(app.store.config.workspaceAgent.permissions.readMemory, false);
  await page.getByRole('button', { name: 'Review 1 change' }).click();
  await dialog.getByRole('heading', { name: 'concurrency', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Approve changes' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Settings changed since this proposal' })
    .waitFor();
  assert.equal(app.store.config.concurrency, 2);
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(configurationProposals(app.store)[0].status, 'rejected');
  const proposal = proposeConfiguration(
    app.store,
    [{ path: ['concurrency'], value: 3 }],
    'Allow independent tasks to run together',
  );
  await page.getByRole('button', { name: 'Review 1 change' }).click();
  await dialog.getByRole('button', { name: 'Approve changes' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(app.store.config.concurrency, 3);
  assert.equal(
    configurationProposals(app.store).find((item) => item.id === proposal.id).status,
    'approved',
  );
  const draft = app.engine.create({ title: 'Configure this draft', demo: true });
  proposeTaskChanges(
    app.store,
    [{ taskId: draft.id, operation: 'settings', settings: { preset: 'small' } }],
    'Use the focused workflow',
  );
  await page.getByRole('button', { name: 'Review 1 tasks' }).click();
  await dialog.getByRole('heading', { name: 'Configure this draft' }).waitFor();
  assert.notEqual(app.store.get(draft.id).preset, 'small');
  await dialog.getByRole('button', { name: 'Approve changes' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(app.store.get(draft.id).preset, 'small');
  await page.reload();
  await page.getByRole('button', { name: 'Relay model and permissions' }).waitFor();
  assert.match(await page.locator('.relay-model-button').innerText(), /chosen-model/);
  await page.evaluate(() => window.RelayTheme.set('dark'));
  await page.waitForTimeout(300);
  await assertReadableText(page);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/relay-compact-header-dark.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('button', { name: 'Relay model and permissions' }).click();
  await dialog.getByRole('heading', { name: 'Relay model and permissions' }).waitFor();
  await page.waitForTimeout(300);
  await assertReadableText(page);
  await page.screenshot({ path: 'docs/screenshots/relay-permissions-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'Workspace permissions passed: compact header, model/effort, persisted scopes, exact proposal review, stale approval rejection, approval/rejection, mobile and dark contrast.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
