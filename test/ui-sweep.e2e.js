import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { createMemory } from '../server/memory.js';
import { assertReadableText } from './browser-contrast.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-ui-sweep-'));
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  const task = app.engine.create({ title: 'Improve query validation', demo: true });
  Object.assign(task, {
    demo: false,
    status: 'completed',
    stage: 'review',
    description:
      'Validate query boundaries and document the behavior. Preserve the existing public interface.',
    repository: { id: 'example', name: 'Example project', strategy: 'managed' },
    workspace: join(directory, 'trees', `relay-${task.id}`, 'src'),
    branch: `relay/${task.id}`,
    publication: {
      state: 'open',
      draft: true,
      title: 'Improve query boundary validation',
      url: 'https://code.example/team/project/pull/42',
      number: '42',
      checks: 'passing',
      review: 'required',
    },
    delivery: {
      id: 'publish',
      status: 'complete',
      phase: 'monitoring',
      harness: 'codex',
      startedAt: '2026-01-01T00:20:00Z',
      finishedAt: '2026-01-01T00:21:00Z',
      summary: 'Pushed the accepted change and opened a draft PR.',
      details: 'Compared the remote branch with the accepted local commit.',
      evidence: ['Remote branch matches accepted changes'],
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
  });
  task.attempts = [
    ['triage', null, 'codex', 'complete'],
    ['investigate', null, 'codex', 'complete'],
    ['plan', null, 'claude', 'complete'],
    ['implement', null, 'codex', 'blocked'],
    ['implement', 'debug', 'claude', 'complete'],
    ['implement', null, 'codex', 'complete'],
    ['verify', 'verifier', 'claude', 'complete'],
    ['review', null, 'claude', 'complete'],
  ].map(([stage, role, harness, verdict], i) => ({
    id: `run-${i}`,
    stage,
    role,
    harness,
    status: 'complete',
    model: 'example-model',
    parentAttemptId: i ? `run-${i - 1}` : null,
    startedAt: `2026-01-01T00:${String(i * 2).padStart(2, '0')}:00Z`,
    finishedAt: `2026-01-01T00:${String(i * 2 + 1).padStart(2, '0')}:00Z`,
    handoff: {
      verdict,
      summary:
        verdict === 'blocked'
          ? 'A focused test needs investigation.'
          : 'Completed the scoped work with evidence.',
      evidence: ['Inspected the affected code path', 'Recorded the focused regression result'],
      details: 'The implementation preserves existing behavior outside the requested surface.',
    },
  }));
  const memorySnapshot = {
    entries: [
      {
        id: 'memory',
        title: 'Keep changes focused',
        scope: 'global',
        kind: 'preference',
        revision: 1,
        content:
          'Change the requested surface and relevant callers. Explain additional scope before proceeding.',
        evidence: 'Explicit developer preference.',
      },
    ],
    omitted: 0,
  };
  for (const run of task.attempts) run.memorySnapshot = memorySnapshot;
  task.delivery.memorySnapshot = memorySnapshot;
  app.store.save(task);
  createMemory(app.store, {
    scope: 'global',
    kind: 'preference',
    title: 'Keep changes focused',
    content:
      'Change the requested surface and relevant callers. Explain any additional scope before proceeding.',
    evidence: 'Explicit developer preference.',
    status: 'active',
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function check(name, width) {
    await assertReadableText(page);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `${name} fits viewport`,
    );
    if (process.env.RELAY_VISUAL_DIR) {
      await mkdir(process.env.RELAY_VISUAL_DIR, { recursive: true });
      await page.screenshot({
        path: join(process.env.RELAY_VISUAL_DIR, `${name}-${width}.png`),
        fullPage: true,
      });
    }
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#task/${task.id}/overview`);
    await page.locator('.workspace-card').waitFor();
    await page.getByText('Workspace details', { exact: true }).click();
    assert.ok(
      await page
        .locator('.workspace-branch code')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) <= 13),
    );
    await check('workspace', width);
    await page.getByRole('button', { name: /View run history/ }).click();
    await page.getByRole('heading', { name: 'Memory used', exact: true }).waitFor();
    assert.ok(
      await page
        .locator('.memory-history .memory-run-entry')
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) >= 14),
    );
    assert.equal(await page.getByText('1 memories', { exact: false }).count(), 0);
    await check('memory-history', width);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

    await page.getByRole('button', { name: 'Open execution graph', exact: true }).click();
    await page.getByRole('region', { name: 'Execution graph', exact: true }).waitFor();
    assert.equal(await page.locator('.graph-lane-title').count(), 3);
    await page.getByRole('button', { name: 'Fit view', exact: true }).click();
    await check('graph', width);
    await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await page.locator('.graph-node').nth(4).click();
    await page.locator('.graph-inspector h3').filter({ hasText: 'Debugger' }).waitFor();
    await page.getByRole('button', { name: 'Close execution graph', exact: true }).click();
    await page.getByRole('button', { name: 'PR details for Example project', exact: true }).click();
    await page.locator('dialog .pr-detail-link').waitFor();
    await check('pr-details', width);
    await page.getByText('Branch & commit', { exact: true }).click();
    await page.locator('dialog .detail-path').first().waitFor();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.getByRole('heading', { name: 'Keep changes focused', exact: true }).waitFor();
    await check('memory', width);
    await page.getByRole('button', { name: 'Add memory', exact: true }).click();
    await page.locator('#memory-form').waitFor();
    await page
      .getByRole('combobox', { name: 'Applies to', exact: true })
      .getByText('Global · all projects', { exact: true })
      .waitFor();
    await page.getByRole('combobox', { name: 'Type', exact: true }).click();
    await page.getByRole('option', { name: 'Observation', exact: true }).click();
    assert.equal(await page.locator('[name="kind"]').inputValue(), 'observation');
    assert.equal(await page.locator('.memory-advanced').getAttribute('open'), null);
    await check('memory-form', width);
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.locator('#memory-expiry').waitFor();
    await check('memory-advanced', width);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log(
    'UI sweep browser checks passed: workspace typography, graph selection/fit, PR details, memory cards/forms, contrast, and mobile layout.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
