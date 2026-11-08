import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { mockDiscovery } from './discovery-fixtures.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-productivity-ui-'));
const app = createApp({
  directory,
  publicDirectory: resolve('public'),
  engineOptions: { demoDelay: 1 },
});
let browser;
try {
  const planned = app.engine.create({
    title: 'Repair a bounded edge case',
    demo: true,
    preset: 'bugfix',
  });
  planned.status = 'awaiting_plan';
  planned.stage = 'plan';
  planned.attempts = [
    {
      id: 'plan',
      stage: 'plan',
      status: 'complete',
      harness: 'claude',
      startedAt: new Date().toISOString(),
      handoff: {
        summary: 'A focused repair preserves compatibility.',
        evidence: ['Reproduced the edge case'],
        options: [
          {
            id: 'focused',
            title: 'Focused repair',
            description: 'Repair the boundary and test it.',
            tradeoffs: 'Keeps the existing API.',
          },
        ],
      },
    },
  ];
  app.store.save(planned);
  const result = app.engine.create({
    title: 'Coordinate a service and consumer',
    demo: true,
    preset: 'cross-repo',
  });
  result.demo = false;
  result.status = 'completed';
  result.stage = 'review';
  result.verifiedFingerprint = 'verified';
  result.reviewedFingerprint = 'reviewed';
  const repository = { ...result.repository, id: 'service', name: 'Example service' };
  result.repository = repository;
  result.repositories = [
    {
      repository,
      publication: {
        state: 'open',
        checks: 'passing',
        review: 'required',
        url: 'https://code.example/pull/1',
        title: 'Service change',
      },
    },
    { repository: { ...repository, id: 'consumer', name: 'Example consumer' } },
  ];
  result.dependencies = [{ repositoryId: 'consumer', dependsOn: 'service' }];
  result.attempts = [
    {
      id: 'impl',
      stage: 'implement',
      status: 'complete',
      harness: 'codex',
      repositoryId: 'service',
      handoff: { verdict: 'complete', summary: 'Added compatibility support', risks: [] },
    },
    {
      id: 'verify',
      stage: 'verify',
      status: 'complete',
      handoff: {
        verdict: 'complete',
        checks: [{ name: 'Changed surface regression', code: 0 }],
        risks: [],
      },
    },
    {
      id: 'review',
      stage: 'review',
      status: 'complete',
      harness: 'claude',
      handoff: {
        verdict: 'complete',
        summary: 'Both repository changes preserve the contract.',
        evidence: ['Contract regression passed'],
        risks: ['Roll out the service before the consumer.'],
      },
    },
  ];
  app.store.save(result);
  const attention = app.engine.create({ title: 'Inspect repeated diagnostic failure', demo: true });
  attention.status = 'blocked';
  attention.stage = 'implement';
  attention.loopGuard = {
    count: 3,
    stopped: true,
    guidance: 'Try a different supported hypothesis.',
  };
  attention.attempts = [
    {
      id: 'failure',
      stage: 'implement',
      status: 'complete',
      handoff: {
        verdict: 'blocked',
        summary: 'A repeated failure',
        evidence: ['Recorded command exited 1'],
      },
    },
  ];
  app.store.save(attention);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#inbox');
  await page.locator('.inbox-options').waitFor();
  assert.match(await page.locator('.inbox-options').innerText(), /Focused repair/);
  await page.locator('[data-action="inbox-decide"][data-operation="approve-plan"]').click();
  await page.locator('#dialog').waitFor();
  assert.match(await page.locator('#dialog').innerText(), /Verification and independent review/);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  await page.goto(`${base}/#task/${result.id}/overview`);
  await page.locator('.completion-brief').waitFor();
  assert.match(await page.locator('.completion-brief').innerText(), /Verified/);
  assert.match(await page.locator('.coordination-panel').innerText(), /Land after Example service/);
  await page.route('**/api/tasks/*/feedback', async (route) => {
    const request = route.request().postDataJSON();
    const stored = app.store.get(result.id);
    const entry = stored.repositories.find((e) => e.repository.id === request.repositoryId);
    entry.feedbackAutopilot = { enabled: request.enabled };
    app.store.save(stored);
    await route.fulfill({ json: stored });
  });
  await page.locator('[data-action="feedback-toggle"]').click();
  await page.getByText('Watching PR', { exact: true }).waitFor();
  assert.equal(await page.locator('#dialog').isVisible(), false);
  await page.locator('.completion-brief summary').first().click();
  await page.locator('.completion-brief ul').first().waitFor();
  assert.match(await page.locator('.completion-brief').innerText(), /Changed surface regression/);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/workflow-intelligence.png' });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    const bounds = await page.locator('.coordination-panel').evaluate((el) => ({
      right: el.getBoundingClientRect().right,
      view: innerWidth,
      overflow: el.scrollWidth > el.clientWidth,
    }));
    assert.ok(bounds.right <= bounds.view + 1 && !bounds.overflow, JSON.stringify(bounds));
  }
  await page.goto(`${base}/#task/${attention.id}/overview`);
  await page.locator('.health-panel').waitFor();
  await page.locator('.health-panel summary').click();
  assert.match(await page.locator('.health-panel').innerText(), /Repeated failure/);
  await page.locator('[data-action="new-task"]').first().click();
  await page.locator('#new-preset').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#new-preset option').count(), 5);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(
    'Productivity browser checks passed: queue approval confirmation, result evidence, cross-repo order, feedback opt-in, health disclosure, presets, responsive layout.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
