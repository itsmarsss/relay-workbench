import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { mockDiscovery } from './discovery-fixtures.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-chat-tabs-'));
const seed = new Store(directory);
seed.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(
  'workspace-agent',
  JSON.stringify([
    {
      id: 'workspace-original',
      question: 'Original workspace prompt',
      answer: '**Workspace reply**',
      status: 'complete',
    },
  ]),
);
seed.close();
const app = createApp({
  directory,
  publicDirectory: resolve('public'),
  engineOptions: {
    sideAnswer: async () => 'New side reply',
    workspaceAgentRun: async (_command, _args, options) => {
      options.onLine(JSON.stringify({ type: 'result', result: 'New workspace reply' }), 'stdout');
      return { code: 0, stderr: '' };
    },
  },
});
let browser;
try {
  app.store.config.harnesses.claude.command = process.execPath;
  const task = app.engine.create({ title: 'Motion and chat actions', demo: true });
  task.sideQuestions = [
    {
      id: 'side-original',
      question: 'Original side prompt',
      answer: '**Side reply**',
      status: 'complete',
      stage: 'triage',
      createdAt: new Date().toISOString(),
    },
  ];
  app.store.save(task);
  const completed = app.engine.create({ title: 'Completed task', demo: true });
  completed.status = 'completed';
  app.store.save(completed);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mockDiscovery(page);
  await page.addInitScript(() => {
    window.copiedMessages = [];
    navigator.clipboard.writeText = async (text) => {
      window.copiedMessages.push(text);
    };
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function movingIndicator(selector, target) {
    const sample = await page.locator(selector).evaluate((bar, target) => {
      const marker = bar.querySelector('[data-tab-indicator]');
      const from = marker.getBoundingClientRect().left;
      const values = [];
      bar.querySelector(target).click();
      const start = performance.now();
      return new Promise((resolve) => {
        function frame() {
          values.push(marker.getBoundingClientRect().left);
          if (performance.now() - start < 400) requestAnimationFrame(frame);
          else resolve({ from, to: marker.getBoundingClientRect().left, values });
        }
        requestAnimationFrame(frame);
      });
    }, target);
    assert.ok(Math.abs(sample.to - sample.from) > 20, JSON.stringify(sample));
    assert.ok(
      sample.values.some(
        (x) => x > Math.min(sample.from, sample.to) + 1 && x < Math.max(sample.from, sample.to) - 1,
      ),
      'selection slides through intermediate positions',
    );
  }
  await page.goto(`${base}/#tasks`);
  await page.locator('.task-scopes [data-tab-indicator]').waitFor();
  await movingIndicator('.task-scopes', '[data-filter="completed"]');
  const scopeStyle = await page
    .locator('.task-scopes > button')
    .first()
    .evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      size: getComputedStyle(node).fontSize,
      padding: getComputedStyle(node).padding,
    }));
  await page.goto(`${base}/#task/${task.id}/overview?chat=1`);
  await page.locator('.detail-tabs [data-tab-indicator]').waitFor();
  await movingIndicator('.detail-tabs', '[data-tab="thread"]');
  const detailStyle = await page
    .locator('.detail-tabs > button')
    .first()
    .evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      size: getComputedStyle(node).fontSize,
      padding: getComputedStyle(node).padding,
    }));
  assert.deepEqual(detailStyle, scopeStyle, 'both tab bars use the same sizing and typography');
  const side = page.locator('.side-chat-history article').first();
  await side.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  await side.getByRole('button', { name: 'Copy reply', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.copiedMessages.slice(-2)), [
    'Original side prompt',
    '**Side reply**',
  ]);
  await side.getByRole('button', { name: 'Edit prompt', exact: true }).click();
  const dialog = page.locator('#dialog');
  await dialog.locator('#chat-edit-question').fill('Revised side prompt');
  await dialog.getByRole('button', { name: 'Send revision', exact: true }).click();
  await page.getByText('New side reply', { exact: true }).waitFor();
  assert.equal(app.store.get(task.id).sideQuestions[0].question, 'Original side prompt');
  assert.equal(app.store.get(task.id).sideQuestions.at(-1).revisionOf, 'side-original');
  await page.goto(`${base}/#assistant`);
  await page.locator('.workspace-messages article').first().waitFor();
  const workspace = page.locator('.workspace-messages article').first();
  await workspace.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  await workspace.getByRole('button', { name: 'Copy reply', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.copiedMessages.slice(-2)), [
    'Original workspace prompt',
    '**Workspace reply**',
  ]);
  await workspace.getByRole('button', { name: 'Edit prompt', exact: true }).click();
  await dialog.locator('#chat-edit-question').fill('Revised workspace prompt');
  await dialog.getByRole('button', { name: 'Send revision', exact: true }).click();
  await page.getByText('New workspace reply', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('New workspace reply', { exact: true }).waitFor();
  await page.goto(`${base}/#settings`);
  await page.locator('#low-motion').check();
  await page.goto(`${base}/#task/${task.id}/overview`);
  await page.locator('.detail-tabs').waitFor();
  const low = await page.locator('.detail-tabs').evaluate((bar) => {
    bar.querySelector('[data-tab="thread"]').click();
    return bar.querySelector('[data-tab-indicator]').getAnimations().length;
  });
  assert.equal(low, 0);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/shared-tabs.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Chat and tab checks passed: moving indicators, shared styling, low motion, copy prompt/reply, revision submission and preserved history in both chats.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
