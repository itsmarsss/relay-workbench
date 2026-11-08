import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { git } from '../server/workspace.js';
import { mockDiscovery } from './discovery-fixtures.js';
import { assertReadableText } from './browser-contrast.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-profile-ui-'));
const root = join(directory, 'repo');
await mkdir(root);
await git(root, ['init']);
await writeFile(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'example-detected',
    packageManager: 'pnpm@10.0.0',
    scripts: { test: 'never run', lint: 'never run' },
  }),
);
await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
await writeFile(join(root, 'AGENTS.md'), 'Project guidance');
const app = createApp({ directory: join(directory, 'state'), publicDirectory: resolve('public') });
let browser;
try {
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
  await page.goto(`${base}/#repositories`);
  await page.getByRole('button', { name: 'Add repository', exact: true }).first().click();
  await page.locator('#repo-path').fill(root);
  await page.getByRole('button', { name: 'Detect', exact: true }).click();
  await page.getByText('Guidance found:', { exact: false }).waitFor();
  assert.equal(await page.locator('#repo-name').inputValue(), 'example-detected');
  assert.equal(await page.locator('#repo-verification').inputValue(), 'agent');
  assert.equal(await page.locator('#repo-checks').inputValue(), '');
  await page.locator('#repo-name').fill('My chosen name');
  await page.getByRole('button', { name: 'Detect', exact: true }).click();
  await page.getByRole('button', { name: 'Add check', exact: true }).first().waitFor();
  assert.equal(await page.locator('#repo-name').inputValue(), 'My chosen name');
  await page.getByRole('button', { name: 'Add check', exact: true }).first().click();
  assert.equal(await page.locator('#repo-verification').inputValue(), 'commands');
  assert.equal(await page.locator('#repo-checks').inputValue(), '["pnpm","run","test"]');
  await page.locator('#dialog #toast:popover-open').waitFor();
  assert.equal(await page.locator('#toast').getAttribute('role'), 'status');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'toast');
  const oldToast = await page.locator('#toast').elementHandle();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByRole('button', { name: 'Add check', exact: true }).first().click();
  assert.equal(
    (await page.locator('#repo-checks').inputValue()).split('\n').length,
    1,
    'suggestions do not duplicate existing commands',
  );
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: 'Add setup', exact: true }).click();
    await page.locator('#dialog #toast:popover-open').waitFor();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    const layout = await page.evaluate(() => {
      const heading = document.querySelector('.repository-dialog .modal-heading');
      const title = heading.querySelector('h2').getBoundingClientRect();
      const description = document.querySelector('.profile-intro').getBoundingClientRect();
      return {
        border: getComputedStyle(heading).borderBottomWidth,
        gap: description.top - title.bottom,
      };
    });
    assert.equal(layout.border, '0px');
    assert.ok(layout.gap >= 6 && layout.gap <= 20);
    await assertReadableText(page);
    if (process.env.RELAY_VISUAL_DIR) {
      await mkdir(process.env.RELAY_VISUAL_DIR, { recursive: true });
      await page.screenshot({
        path: join(process.env.RELAY_VISUAL_DIR, `profile-suggestions-${width}.png`),
      });
    }
  }
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(
    await oldToast.evaluate((node) => node.isConnected),
    true,
    'closing a dialog preserves the notification region',
  );
  await page.locator('body > #toast').waitFor({ state: 'attached' });
  assert.equal(await page.locator('body > #toast').count(), 1);
  await page.getByRole('button', { name: 'Add repository', exact: true }).first().click();
  const alternate = join(directory, 'alternate');
  await mkdir(alternate);
  await git(alternate, ['init']);
  await writeFile(join(alternate, 'package.json'), JSON.stringify({ name: 'latest-project' }));
  let releaseOld, oldStarted;
  const oldHeld = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const oldReady = new Promise((resolve) => {
    oldStarted = resolve;
  });
  await page.route('**/api/repositories/suggestions', async (route) => {
    if (route.request().postDataJSON().path === root) {
      oldStarted();
      await oldHeld;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          root,
          cwd: '.',
          guidance: [],
          suggestions: [
            {
              field: 'name',
              label: 'Repository name',
              value: 'outdated-project',
              evidence: 'Old request',
            },
          ],
        }),
      });
    } else await route.continue();
  });
  await page.locator('#repo-path').fill(root);
  await page.locator('#repo-path').press('Tab');
  await oldReady;
  await page.locator('#repo-path').fill(alternate);
  await page.locator('#repo-path').press('Tab');
  await page.waitForFunction(() => document.querySelector('#repo-name').value === 'latest-project');
  releaseOld();
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator('#repo-name').inputValue(),
    'latest-project',
    'late metadata must not overwrite the latest folder',
  );
  await page.unroute('**/api/repositories/suggestions');
  await page.locator('#repo-name').fill('Failure stays visible');
  await page.locator('#repo-path').fill('/example/missing-checkout');
  await page.getByRole('button', { name: 'Save repository', exact: true }).click();
  await page.locator('#dialog #toast.error:popover-open').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Repository profile checks passed: metadata suggestions, non-destructive application, command deduplication, modal top-layer notifications, close/reopen persistence, header spacing and responsive contrast.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
