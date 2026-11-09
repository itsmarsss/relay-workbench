import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { automationState } from '../server/workflow-automation.js';
import { proposeTaskChanges } from '../server/task-proposals.js';
import { captureCheckpoint } from '../server/workflow-checkpoints.js';
import { demoHandoff } from '../server/harness.js';
import { mockDiscovery } from './discovery-fixtures.js';
import { assertReadableText } from './browser-contrast.js';
const directory = await mkdtemp(join(tmpdir(), 'relay-chat-controls-ui-'));
let first, second, duplicate;
const app = createApp({
  directory,
  publicDirectory: resolve('public'),
  engineOptions: {
    workspaceAgentRun: async (_command, args, options) => {
      const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
      const [, origin, capability] = config.mcpServers.relay_workspace.args;
      const response = await fetch(origin + '/api/workspace-agent/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Workspace': capability },
        body: JSON.stringify({
          name: 'propose_task_changes',
          args: {
            reason: 'Finish this task through reviewed work',
            changes: [
              { taskId: first.id, operation: 'automation', enabled: true, scope: 'reviewed' },
            ],
          },
        }),
      });
      assert.equal(response.status, 200);
      assert.match(options.input, /Mention tasks with/);
      const result = `Review Auto for [@${first.title}](#task/${first.id}/overview). Compare @${second.title}.\n\nKeep code literal: \`@${second.title}\`.\n\nAmbiguous: @Duplicate task. Exact: [@Duplicate task](#task/${duplicate.id}/overview).`;
      options.onLine(JSON.stringify({ type: 'result', result }), 'stdout');
      return { code: 0, stderr: '' };
    },
  },
});
app.engine.tick = () => {};
let browser;
try {
  app.store.setConfig({
    ...app.store.config,
    harnesses: {
      ...app.store.config.harnesses,
      claude: { ...app.store.config.harnesses.claude, enabled: true, command: process.execPath },
    },
  });
  first = app.engine.create({ title: 'Primary task', demo: true });
  second = app.engine.create({ title: 'Saved proposal', demo: true });
  duplicate = app.engine.create({ title: 'Duplicate task', demo: true });
  app.engine.create({ title: 'Duplicate task', demo: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#assistant');
  await page.locator('#workspace-request').fill('Enable Auto and compare these tasks');
  await page.locator('#workspace-request').press('Enter');
  await page.locator('[data-action="review-task-proposal"]').waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('.side-chat-response a.task-mention').length === 3,
  );
  assert.equal(await page.locator('.side-chat-response code a').count(), 0);
  assert.equal(
    await page.locator(`.side-chat-response a[href="#task/${duplicate.id}/overview"]`).count(),
    1,
  );
  assert.equal(automationState(app.store, first.id).enabled, false);
  await page.reload();
  await page.locator('[data-action="review-task-proposal"]').click();
  await page.locator('#dialog').waitFor();
  assert.match(
    await page.locator('#dialog').innerText(),
    /Accept verified\/reviewed work; publication stays manual/,
  );
  await assertReadableText(page, 'Task action approval', '#dialog');
  await page.locator('[data-action="decide-task-proposal"][data-decision="approve"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="decide-task-proposal"]'));
  assert.equal(automationState(app.store, first.id).enabled, true);
  assert.equal(app.store.get(first.id).status, 'draft');
  second.status = 'awaiting_plan';
  second.stage = 'plan';
  second.attempts = [
    { id: 'plan', stage: 'plan', status: 'complete', handoff: demoHandoff(second, 'plan') },
  ];
  app.store.save(second);
  const point = await captureCheckpoint(app.store, second, second.attempts[0]);
  proposeTaskChanges(
    app.store,
    [{ taskId: second.id, operation: 'checkpoint', checkpointId: point.id, stage: 'approach' }],
    'Explore another approach',
  );
  await page.reload();
  await page.locator('[data-action="review-task-proposal"]').click();
  assert.match(
    await page.locator('#dialog').innerText(),
    /Create a separate checkpoint continuation/,
  );
  await page.locator('[data-action="decide-task-proposal"][data-decision="approve"]').click();
  const continuation = page.locator('.workspace-permission a.task-mention');
  await continuation.waitFor();
  const fork = app.store.all().find((task) => task.fork?.sourceTaskId === second.id);
  assert.ok(fork);
  assert.equal(await continuation.getAttribute('href'), `#task/${fork.id}/overview`);
  await continuation.click();
  await page.waitForURL((url) => url.hash.includes(fork.id));
  assert.equal(fork.status, 'awaiting_plan');
  assert.deepEqual(errors, []);
  console.log(
    'Workspace controls browser checks passed: reply mentions, exact approval, Auto, checkpoint links, contrast and navigation.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
