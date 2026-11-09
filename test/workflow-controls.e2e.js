import { captureCheckpoint } from '../server/workflow-checkpoints.js';
import { blockerDecision } from '../server/recovery.js';
import { demoHandoff } from '../server/harness.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { mockDiscovery } from './discovery-fixtures.js';
import { assertReadableText } from './browser-contrast.js';

const directory = await mkdtemp(join(tmpdir(), 'relay-workflow-ui-'));
const app = createApp({
  directory,
  publicDirectory: resolve('public'),
  engineOptions: { demoDelay: 1 },
});
let browser;
try {
  const task = app.engine.create({ title: 'Overnight workflow controls', demo: true });
  await app.engine.action(task.id, 'start');
  for (
    let i = 0;
    i < 500 &&
    (app.store.get(task.id).status !== 'awaiting_plan' || app.engine.running.has(task.id));
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(`${base}/#task/${task.id}/overview`);
  await page.locator('[data-action="configure-auto"]').click();
  await page.locator('#dialog').waitFor();
  await assertReadableText(page, 'Auto mode dialog', '#dialog');
  const autoBox = await page
    .locator('[data-action="enable-auto"][data-scope="reviewed"]')
    .boundingBox();
  assert.ok(autoBox.height > 60 && autoBox.height < 180, JSON.stringify(autoBox));
  await page.locator('[data-action="enable-auto"][data-scope="reviewed"]').click();
  await page.locator('#dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Auto on', exact: true }).waitFor();
  for (let i = 0; i < 500 && app.store.get(task.id).status !== 'completed'; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.store.get(task.id).status, 'completed');
  await page.reload();
  await page.locator('[data-action="tab"][data-tab="thread"]').click();
  await page.locator('[data-action="activity-run"][data-run="all"]').click();
  await page
    .getByRole('heading', { name: 'Auto enabled: finish through reviewed result.' })
    .waitFor();
  await page.getByRole('heading', { name: /Checkpoint saved after plan/ }).waitFor();
  // Reopen a plan directly; a fresh investigation/planning run must not start.
  await page.locator('[data-action="workflow-checkpoints"]').click();
  await page
    .locator('.checkpoint-list article')
    .filter({ has: page.getByText('After plan', { exact: true }) })
    .locator('[data-action="fork-checkpoint"]')
    .click();
  await page.locator('#checkpoint-stage').selectOption('approach', { force: true });
  await page.locator('[data-action="confirm-fork-checkpoint"]').click();
  await page.waitForURL((url) => url.hash.startsWith('#task/') && !url.hash.includes(task.id));
  await page.locator('#approve-form').waitFor();
  const approachFork = app.store.all().find((item) => item.fork?.mode === 'approach');
  assert.ok(approachFork);
  assert.equal(approachFork.attempts.filter((attempt) => !attempt.inherited).length, 0);
  assert.equal(await page.locator('#approve-form .approach-option').count(), 2);
  await page.goto(`${base}/#task/${task.id}/overview`);
  await page.locator('[data-action="open-execution-map"]').click();
  await page.locator('.graph-node[data-id^="checkpoint-"]').first().click();
  await page.locator('.graph-inspector [data-action="fork-checkpoint"]').click();
  await page.locator('#dialog').waitFor();
  assert.equal(
    await page.locator('.graph-dialog').count(),
    0,
    'Graph must yield focus to the continuation dialog',
  );
  await page.locator('#checkpoint-note').fill('Try an alternate approach.');
  await assertReadableText(page, 'Checkpoint continuation', '#dialog');
  await page.locator('[data-action="confirm-fork-checkpoint"]').click();
  await page.waitForURL((url) => url.hash.startsWith('#task/') && !url.hash.includes(task.id));
  await page.getByRole('link', { name: 'Original workflow ↗' }).waitFor();
  const fork = app.store
    .all()
    .find((item) => item.fork?.sourceTaskId === task.id && item.fork.mode === 'saved');
  assert.ok(fork);
  assert.equal(fork.status, 'paused');
  assert.equal(await page.getByRole('button', { name: 'Auto mode', exact: true }).count(), 1);
  await page.locator('[data-action="open-execution-map"]').click();
  await page.locator('.graph-node[data-id^="fork-"]').click();
  await page.getByRole('link', { name: 'Open linked workflow ↗' }).waitFor();
  await page.screenshot({ path: '/tmp/relay-workflow-controls.png', fullPage: true });
  const debugging = app.engine.create({ title: 'Debugger choice UI', demo: true });
  debugging.attempts = structuredClone(app.store.get(task.id).attempts);
  debugging.chosenApproach = app.store.get(task.id).chosenApproach;
  const diagnosis = {
    ...demoHandoff(debugging, 'investigate'),
    verdict: 'blocked',
    summary: 'Choose a supported remedy',
    options: [
      {
        id: 'remedy-two',
        title: 'Try the alternate remedy',
        description: 'Use another supported approach.',
        tradeoffs: 'Needs targeted checks.',
      },
    ],
  };
  const attempt = {
    id: 'debug-ui',
    role: 'debug',
    stage: 'implement',
    status: 'complete',
    handoff: diagnosis,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  debugging.attempts.push(attempt);
  debugging.stage = 'implement';
  debugging.status = 'blocked';
  debugging.blockerDecision = blockerDecision(debugging, diagnosis);
  app.store.save(debugging);
  await captureCheckpoint(app.store, debugging, attempt);
  await page.goto(`${base}/#task/${debugging.id}/overview`);
  await page.locator('[data-action="workflow-checkpoints"]').click();
  await page.locator('.checkpoint-list [data-action="fork-checkpoint"]').click();
  await page.locator('#checkpoint-stage').selectOption('decision', { force: true });
  await page.locator('[data-action="confirm-fork-checkpoint"]').click();
  await page.waitForURL((url) => url.hash.startsWith('#task/') && !url.hash.includes(debugging.id));
  await page.getByRole('heading', { name: 'Choose how to continue' }).waitFor();
  await page.locator('[data-action="resolve-blocker"][data-option-id="remedy-two"]').waitFor();
  assert.equal(app.store.get(debugging.id).status, 'blocked');
  assert.deepEqual(errors, []);
  console.log('Workflow controls browser checks passed.');
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
