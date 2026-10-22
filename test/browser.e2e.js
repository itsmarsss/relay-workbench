import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.js';
import { git } from '../server/workspace.js';
import { demoHandoff } from '../server/harness.js';

const { chromium } = await import(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const screenshots = process.env.RELAY_SCREENSHOTS || 'docs/screenshots';
await mkdir(screenshots, { recursive: true });
const fixture = await mkdtemp(join(tmpdir(), 'relay-browser-'));
let localApp, browser;
try {
  let origin = process.env.RELAY_TEST_URL;
  if (!origin) {
    localApp = createApp({
      directory: join(fixture, 'state'),
      publicDirectory: resolve('public'),
      engineOptions: { demoDelay: 30 },
    });
    await new Promise((resolve) => localApp.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${localApp.server.address().port}`;
  }
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
  await page.goto(origin);
  await page.getByRole('heading', { name: /Let’s make progress/ }).waitFor();
  await page.screenshot({ path: join(screenshots, 'overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Try a demo', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose the way forward.' }).waitFor();
  await page.getByRole('button', { name: 'Revise the proposal' }).click();
  await page
    .getByRole('textbox', { name: 'What should change?' })
    .fill('Include boundary cases and preserve compatibility.');
  await page.getByRole('button', { name: /Send feedback/ }).click();
  await page.getByRole('heading', { name: 'Choose the way forward.' }).waitFor();
  await page.locator('input[value="patch-callers"]').check();
  await page.locator('#approval-note').fill('Keep the change focused.');
  await page.screenshot({ path: join(screenshots, 'approach-approval.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve & implement' }).click();
  await page.getByRole('heading', { name: 'The specialists are done. Over to you.' }).waitFor();
  await page.getByRole('tab', { name: /Handoffs/ }).click();
  assert.ok((await page.locator('.handoff-card').count()) >= 6);
  await page.getByRole('tab', { name: 'Code changes' }).click();
  await page.getByRole('heading', { name: 'No real files changed' }).waitFor();
  await page.getByRole('tab', { name: 'Activity thread' }).click();
  await page.screenshot({ path: join(screenshots, 'final-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Request changes', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'What should change?' })
    .fill('Double-check the explicit value behavior.');
  await page.getByRole('button', { name: /Send feedback/ }).click();
  await page.getByRole('heading', { name: 'The specialists are done. Over to you.' }).waitFor();
  await page.getByRole('button', { name: 'Accept result', exact: true }).click();
  await page.locator('.task-subtitle .badge.completed').waitFor();
  const taskUrl = page.url();
  if (localApp) {
    const id = taskUrl.split('/').at(-1);
    localApp.store.event(id, {
      type: 'transcript',
      stream: 'stdout',
      harness: 'codex',
      attemptId: 'history',
      text: JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'I found the caller mismatch. <script>unsafe</script>',
        },
      }),
    });
    localApp.store.event(id, {
      type: 'activity',
      kind: 'tool',
      harness: 'codex',
      attemptId: 'history',
      summary: 'Read request.js',
      details: 'Command output retained here.',
    });
    await page
      .locator('.agent-message')
      .getByText('I found the caller mismatch.', { exact: false })
      .waitFor();
    await page.locator('.tool-activity').last().locator('summary').click();
    await page.getByText('Command output retained here.', { exact: false }).waitFor();
    localApp.store.event(id, {
      type: 'activity',
      kind: 'tool',
      harness: 'codex',
      attemptId: 'history',
      summary: 'Read caller.js',
      details: 'Second result.',
    });
    await page.getByText('Second result.', { exact: false }).waitFor();
    assert.equal(await page.locator('.agent-message script').count(), 0);
  }
  await page.reload();
  await page.locator('.task-subtitle .badge.completed').waitFor();
  await page.getByRole('button', { name: 'All tasks', exact: false }).first().click();
  await page.getByRole('textbox', { name: 'Search tasks' }).fill('does-not-exist');
  await page.getByRole('heading', { name: 'No tasks here yet' }).waitFor();
  await page.getByRole('textbox', { name: 'Search tasks' }).fill('Unify');
  await page.locator('.task-row').first().waitFor();

  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Add repository', exact: true }).first().click();
  const repo = join(fixture, 'repo');
  await mkdir(repo);
  spawnSync('git', ['init', '-b', 'feature/e2e', repo]);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Browser fixture');
  await page.getByRole('textbox', { name: 'Absolute checkout path' }).fill(repo);
  await page
    .locator('#repo-checks')
    .fill(JSON.stringify([process.execPath, '-e', 'process.exit(0)']));
  await page.getByRole('button', { name: 'Save repository' }).click();
  await page.getByRole('heading', { name: 'Browser fixture', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.locator('#new-repository').selectOption({ label: 'Browser fixture' });
  await page.locator('#new-title').fill('<img src=x onerror=alert(1)> Literal task title');
  await page.locator('#new-description').fill('A browser test task; do not launch a live harness.');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page
    .getByRole('heading', { name: '<img src=x onerror=alert(1)> Literal task title', exact: true })
    .waitFor();
  assert.equal(await page.locator('.task-title-row img').count(), 0);

  await page.getByRole('button', { name: 'Harnesses', exact: true }).click();
  await page.getByRole('heading', { name: 'Specialist routing' }).waitFor();
  assert.equal(await page.locator('.harness-card').count(), 3);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Private integration profiles' }).waitFor();
  await page.getByRole('button', { name: 'View configuration' }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(taskUrl);
  await page.reload();
  await page.locator('.task-subtitle .badge.completed').waitFor();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Mobile page must not overflow horizontally',
  );
  await page.screenshot({ path: join(screenshots, 'mobile-task.png'), fullPage: true });
  await page.keyboard.press('n');
  await page.getByRole('dialog').waitFor();
  assert.ok(
    await page.evaluate(
      () => document.querySelector('dialog').getBoundingClientRect().right <= window.innerWidth,
    ),
    'Mobile dialog must fit',
  );
  await page.keyboard.press('Escape');
  if (localApp) {
    const repositories = [];
    for (const id of ['service', 'client']) {
      const path = join(fixture, id);
      await mkdir(path);
      await git(path, ['init', '-b', 'feature/browser']);
      await writeFile(join(path, 'contract.txt'), 'v1');
      await git(path, ['add', '.']);
      await git(path, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-m',
        'test: browser',
      ]);
      repositories.push({
        id,
        name: id,
        path,
        cwd: '.',
        strategy: 'attach',
        setup: [],
        checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
        instructions: '',
        prCommand: { command: process.execPath, args: ['-e', 'console.log("provider")'] },
      });
    }
    localApp.store.setConfig({
      ...localApp.store.config,
      repositories,
      harnesses: Object.fromEntries(
        ['codex', 'claude', 'pi'].map((id) => [
          id,
          { command: process.execPath, model: '', enabled: true },
        ]),
      ),
    });
    localApp.engine.harness = async ({ task, stage }) => {
      if (stage === 'implement') await writeFile(join(task.workspace, 'contract.txt'), 'v2');
      return demoHandoff(task, stage);
    };
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.locator('#new-repository').selectOption('client');
    await page.getByText('Coordinate additional repositories', { exact: true }).click();
    await page.locator('input[name="additionalRepository"][value="service"]').check();
    await page.getByRole('listbox', { name: 'Prerequisites for client' }).selectOption(['service']);
    await page.locator('#new-title').fill('Upgrade service and client');
    await page.getByRole('button', { name: 'Create task', exact: false }).click();
    await page.getByRole('button', { name: 'Start workflow' }).click();
    await page.getByRole('heading', { name: 'Choose the way forward.' }).waitFor();
    await page.getByRole('button', { name: 'Approve & implement' }).click();
    await page.getByRole('heading', { name: 'The specialists are done. Over to you.' }).waitFor();
    assert.equal(
      await page
        .locator('.task-context')
        .getByText('REPOSITORY WORKSPACE', { exact: true })
        .count(),
      2,
    );
    await page.getByRole('tab', { name: 'Code changes' }).click();
    await page.getByText('2 repository diffs', { exact: true }).waitFor();
    assert.equal(await page.locator('.repository-diff').count(), 2);
    await page.getByRole('button', { name: 'Accept result', exact: true }).click();
    await page.locator('.task-subtitle .badge.completed').waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Commit & submit draft PR', exact: true }).count(),
      2,
    );
    await page
      .getByRole('button', { name: 'Commit & submit draft PR', exact: true })
      .first()
      .click();
    await page
      .getByRole('dialog')
      .getByText('Publication is not atomic.', { exact: false })
      .waitFor();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'Multi-repository mobile view must fit',
    );
    await page.reload();
    await page.locator('.task-subtitle .badge.completed').waitFor();
    assert.equal(
      await page
        .locator('.task-context')
        .getByText('REPOSITORY WORKSPACE', { exact: true })
        .count(),
      2,
    );
  }
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Browser checks passed: approvals, feedback loops, reload, search, repository profile, escaped task content, navigation, and mobile layout.\n',
  );
} finally {
  await browser?.close();
  await localApp?.close();
  await rm(fixture, { recursive: true, force: true });
}
