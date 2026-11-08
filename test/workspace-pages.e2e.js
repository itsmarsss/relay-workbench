import { mockDiscovery } from './discovery-fixtures.js';
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
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of [
      'assistant',
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
        assert.equal(await page.locator('#settings-form').isVisible(), true);
        assert.equal(await page.locator('#low-motion').isVisible(), true);
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
  assert.equal(new URL(page.url()).hash.split('?')[0], '#tasks');
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('scope'), 'active');
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
  await page.locator('#codex-model option[value="example-fast"]').waitFor({ state: 'attached' });
  const modelControl = page.locator('relay-select').filter({ has: page.locator('#codex-model') });
  await modelControl.getByRole('combobox').first().click();
  await modelControl
    .getByRole('searchbox')
    .fill('Deep')
    .catch(async () => {
      await modelControl.locator('input[type=search]').fill('Deep');
    });
  await modelControl.getByRole('option', { name: /Example Deep/ }).click();
  assert.equal(await page.locator('#codex-model').inputValue(), 'example-deep');
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#codex-model').inputValue(), 'example-deep');
  await page.locator('#codex-command').fill('custom-codex');
  await page.locator('#pi-enabled').uncheck();
  await page.locator('#route-implement').selectOption('claude', { force: true });
  app.store.event(waiting.id, { type: 'activity', summary: 'A background update' });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#codex-command').inputValue(), 'custom-codex');
  assert.equal(await page.locator('#pi-enabled').isChecked(), false);
  assert.equal(await page.locator('#route-implement').inputValue(), 'claude');
  await page.route('**/api/repositories/discover', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        repositories: [
          { name: 'Detected service', path: '/example/checkouts/service', configured: false },
        ],
        roots: ['/example/checkouts'],
        directories: 2,
        truncated: false,
        warnings: [],
      }),
    }),
  );
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Scan common folders', exact: true }).click();
  await page.locator('[data-action=add-discovered-repository]').click();
  assert.equal(await page.locator('#repo-path').inputValue(), '/example/checkouts/service');
  assert.equal(await page.locator('#repository-form [name=name]').inputValue(), 'Detected service');
  assert.equal(app.store.config.repositories.length, 1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#setting-recovery').fill('4');
  app.store.event(waiting.id, { type: 'activity', summary: 'Another background update' });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('#setting-recovery').inputValue(), '4');
  // Exercise routing advice with populated and historical evidence.
  const evidenceRow = {
    stage: 'implement',
    harness: 'claude',
    model: '',
    attempts: 4,
    settled: 4,
    successful: 3,
    failed: 1,
    interrupted: 1,
    pending: 0,
    tasks: 3,
    acceptedTasks: 2,
    reviewFindings: 1,
    medianMs: 60000,
    p90Ms: 120000,
    confidenceLower: 0.3,
    eligible: true,
  };
  const evidence = {
    rows: [
      evidenceRow,
      { ...evidenceRow, harness: 'codex', model: 'retired-model', eligible: false },
      {
        ...evidenceRow,
        harness: 'pi',
        model: null,
        settled: 0,
        successful: 0,
        medianMs: null,
        eligible: false,
      },
    ],
    recommendations: [{ stage: 'implement', harness: 'claude', samples: 4, alternatives: 1 }],
    minimumSamples: 3,
    minimumTasks: 2,
    notes: 'Results reflect observed tasks, not a controlled comparison.',
  };
  await page.route('**/api/outcomes?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(evidence) }),
  );
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page
    .getByText('1 stage could use a different agent. Review the results below.', { exact: true })
    .waitFor();
  const routing = page.getByRole('region', { name: 'Routing evidence', exact: true });
  await routing.getByText('Different model configured', { exact: true }).waitFor();
  await routing.getByText('Model not recorded', { exact: true }).first().waitFor();
  assert.equal(await routing.locator('.evidence-metric strong').first().innerText(), '75%');
  await page.locator('#outcomes-repository').selectOption('example', { force: true });
  await routing
    .getByText(/Updates global defaults for new tasks, using Example service results/)
    .waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await routing.locator('.evidence-details').first().locator('summary').click();
    await routing.getByText('90th percentile time', { exact: true }).first().waitFor();
    await routing.locator('.evidence-method summary').click();
    await assertReadableText(page);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'Routing evidence fits viewport',
    );
    if (process.env.RELAY_VISUAL_DIR)
      await routing.screenshot({
        path: join(process.env.RELAY_VISUAL_DIR, `routing-evidence-${width}.png`),
      });
    await routing.locator('.evidence-details').first().locator('summary').click();
    await routing.locator('.evidence-method summary').click();
  }
  const previousModels = JSON.stringify(app.store.config.harnesses);
  await routing.getByRole('button', { name: 'Apply suggested route', exact: true }).click();
  await routing
    .getByText('Your current routes match the available evidence.', { exact: true })
    .waitFor();
  assert.equal(app.store.config.routing.implement, 'claude');
  assert.equal(JSON.stringify(app.store.config.harnesses), previousModels);
  assert.equal(await routing.locator('[data-action=apply-routing-advice]').count(), 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.waitForFunction(
    () => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === 64,
  );
  assert.equal(
    await page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().width)),
    64,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  const resize = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
  await resize.focus();
  await page.keyboard.press('End');
  assert.equal(await resize.getAttribute('aria-valuenow'), '340');
  await page.reload();
  await page.getByRole('separator', { name: 'Resize sidebar', exact: true }).waitFor();
  assert.equal(
    await page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().width)),
    340,
  );
  const handle = await page.locator('.sidebar-resize').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 150);
  await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y + 150, { steps: 5 });
  await page.mouse.up();
  const resized = await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(resized >= 250 && resized <= 265);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Example service profile', exact: true }).click();
  const profileForm = page.locator('#repository-form');
  await page.locator('#repo-name').fill('');
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await profileForm.getByRole('button', { name: 'Save repository', exact: true }).click();
  assert.equal(
    await page.getByRole('tab', { name: 'General', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.locator('#repo-name').fill('Example service');

  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await page.locator('#repo-strategy').selectOption('managed', { force: true });
  await page.locator('#repo-workspace-command').fill('["example-workspace", "create"]');
  await page.locator('#repo-workspace-path').fill('/example/trees/{workspaceName}');
  await page.getByRole('tab', { name: 'Checks & setup', exact: true }).click();
  assert.equal(await page.locator('#repo-checks').isVisible(), false);
  await page.locator('#repo-verification').selectOption('commands', { force: true });
  await page.locator('#repo-checks').fill('["example-check"]');
  await page.getByRole('tab', { name: 'Guidance', exact: true }).click();
  await page.locator('#repo-instructions').fill('Use **focused checks**.');
  await page
    .locator('[data-editor=repo-instructions]')
    .getByRole('tab', { name: 'Preview', exact: true })
    .click();
  await page.locator('#repo-instructions-preview strong').getByText('focused checks').waitFor();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.locator('#repo-name').fill('Updated service');
  // Opening removal confirmation must preserve all draft fields.
  await profileForm.locator('[data-profile-remove]').click();
  await profileForm.getByRole('button', { name: 'Keep profile', exact: true }).click();
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  assert.equal(
    await page.locator('#repo-workspace-command').inputValue(),
    '["example-workspace", "create"]',
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertReadableText(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (process.env.RELAY_VISUAL_DIR)
      await page
        .locator('#dialog')
        .screenshot({ path: join(process.env.RELAY_VISUAL_DIR, `repository-editor-${width}.png`) });
  }
  await page.route('**/api/repositories/inspect', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await profileForm.getByRole('button', { name: 'Save repository', exact: true }).click();
  await page.getByRole('heading', { name: 'Updated service', exact: true }).waitFor();
  assert.equal(app.store.config.repositories[0].verificationMode, 'commands');
  assert.deepEqual(app.store.config.repositories[0].checks, [
    { command: 'example-check', args: [] },
  ]);
  assert.equal(app.store.config.repositories[0].instructions, 'Use **focused checks**.');
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  assert.equal(
    await page.locator('.main-shell').evaluate((el) => Math.round(el.getBoundingClientRect().left)),
    56,
  );
  await page.getByRole('button', { name: 'All tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('.workflow-board').waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertReadableText(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (process.env.RELAY_VISUAL_DIR)
      await page.screenshot({
        path: join(process.env.RELAY_VISUAL_DIR, `task-board-${width}.png`),
        fullPage: true,
      });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Workspace pages passed: responsive navigation, contrast, live follow-up filters, memory reset, repository mode, settings hierarchy, and draft preservation.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
