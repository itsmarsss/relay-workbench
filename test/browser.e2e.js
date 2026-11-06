import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.js';
import { git } from '../server/workspace.js';
import { demoHandoff } from '../server/harness.js';
import { parseTaskRoute } from '../public/task-route.js';
import { newTask } from '../server/domain.js';
import { assertReadableText } from './browser-contrast.js';

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
      engineOptions: {
        demoDelay: 30,
        sideAnswer: async ({ question }) => `Side answer: ${question}`,
      },
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
  page.on('console', (message) => {
    if (
      /(?:Applying inline style|style-src).*Content Security Policy|Content Security Policy.*style-src/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: /Let’s make progress/ }).waitFor();
  const photo = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 480;
      const context = canvas.getContext('2d');
      context.fillStyle = '#eef4e8';
      context.fillRect(0, 0, 960, 480);
      context.fillStyle = '#173d32';
      context.font = 'bold 42px sans-serif';
      context.fillText('Expected behavior', 48, 76);
      context.font = '24px sans-serif';
      context.fillText('A screenshot attached to a Relay task', 48, 120);
      context.fillStyle = '#557b55';
      context.fillRect(48, 180, 240, 220);
      context.fillStyle = '#8fa98a';
      context.fillRect(328, 240, 240, 160);
      context.fillStyle = '#b7c9aa';
      context.fillRect(608, 290, 240, 110);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  let externalReferrer;
  await page.route('https://images.example.test/**', (route) => {
    externalReferrer = route.request().headers().referer;
    return route.fulfill({ status: 200, contentType: 'image/png', body: photo });
  });

  await assertReadableText(page);
  await page.screenshot({ path: join(screenshots, 'overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Try a demo', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose the way forward.' }).waitFor();
  await page.getByRole('region', { name: 'Current task context' }).waitFor();
  assert.ok(
    (await page
      .locator('.task-summary p')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 14,
  );
  await page.getByRole('tab', { name: 'Activity thread', exact: true }).click();
  await page.getByRole('navigation', { name: 'Activity runs' }).waitFor();
  await page.getByRole('button', { name: 'All activity', exact: true }).click();
  await page.getByRole('heading', { name: 'All activity', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Follow current run' }).click();
  assert.equal(await page.locator('.activity-run.selected').count(), 1);
  await page.screenshot({ path: join(screenshots, 'readable-task-context.png'), fullPage: false });

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
  await page.getByRole('button', { name: 'All activity', exact: true }).click();
  if (localApp) {
    const id = parseTaskRoute(new URL(taskUrl).hash).id;
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
    const openedTool = await page.locator('.tool-activity').last().elementHandle();
    localApp.store.event(id, {
      type: 'activity',
      kind: 'tool',
      harness: 'codex',
      attemptId: 'history',
      summary: 'Read caller.js',
      details: 'Second result.',
    });
    await page.getByText('Second result.', { exact: false }).waitFor();
    assert.ok(
      await openedTool.evaluate((node) => node.isConnected && node.open),
      'Live activity must retain the expanded disclosure itself',
    );
    localApp.store.event(id, {
      type: 'activity',
      kind: 'tool',
      harness: 'codex',
      attemptId: 'history',
      summary: 'Running: /bin/sh -lc ' + 'long-command-argument'.repeat(12),
      details: 'Long command output: ' + 'unbroken-output'.repeat(100),
    });
    await page.locator('.tool-entry').getByText('Running: /bin/sh', { exact: false }).waitFor();
    const toolGroup = page.locator('.tool-activity').last();
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const expanded of [false, true]) {
        await toolGroup.evaluate((el, open) => {
          el.open = open;
        }, expanded);
        const bounds = await toolGroup.evaluate((el) => {
          const body = el.closest('.timeline-body').getBoundingClientRect();
          const summary = el.querySelector('summary').getBoundingClientRect();
          const entries = [...el.querySelectorAll('.tool-entry')];
          return {
            contained: summary.left >= body.left && summary.right <= body.right + 1,
            entriesFit:
              !el.open || entries.every((entry) => entry.scrollWidth <= entry.clientWidth + 1),
            pageFits: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        assert.ok(bounds.contained, `Activity summary must stay inside its column at ${width}px`);
        assert.ok(bounds.entriesFit, `Expanded commands must wrap at ${width}px`);
        assert.ok(bounds.pageFits, `Activity must not widen the page at ${width}px`);
      }
      if (width !== 1024)
        await page.screenshot({
          path: join(screenshots, `activity-overflow-${width}.png`),
          fullPage: true,
        });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    assert.equal(await page.locator('.agent-message script').count(), 0);
  }
  await page.reload();
  await page.locator('.task-subtitle .badge.completed').waitFor();
  await page.getByRole('tab', { name: 'Activity thread', exact: true }).click();
  await page.getByRole('button', { name: 'All activity', exact: true }).click();
  if (localApp)
    await page
      .locator('.agent-message')
      .getByText('I found the caller mismatch.', { exact: false })
      .waitFor();
  await page.getByRole('button', { name: 'All tasks', exact: false }).first().click();
  await page.getByRole('textbox', { name: 'Search tasks' }).fill('does-not-exist');
  await page.getByRole('heading', { name: 'No tasks here yet' }).waitFor();
  await page.getByRole('textbox', { name: 'Search tasks' }).fill('Unify');
  await page.locator('.task-list-row').first().waitFor();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('.board-card').first().waitFor();
  await page
    .getByRole('region', { name: 'Done', exact: true })
    .locator('.board-card')
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.locator('.task-list-row').first().waitFor();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('.workflow-board').waitFor();
  await page.screenshot({ path: join(screenshots, 'workflow-board.png'), fullPage: true });

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
  await page.locator('#new-repository').selectOption({ label: 'Browser fixture' }, { force: true });
  await page.locator('#new-title').fill('<img src=x onerror=alert(1)> Literal task title');
  await page.locator('#new-description').fill('A browser test task; do not launch a live harness.');
  await page.locator('#new-ticket').fill('https://github.com/example/service/issues/42');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page
    .getByRole('heading', { name: '<img src=x onerror=alert(1)> Literal task title', exact: true })
    .waitFor();
  assert.equal(await page.locator('.task-title-row img').count(), 0);
  await page
    .getByRole('region', { name: 'Description and requirements', exact: true })
    .getByText('A browser test task; do not launch a live harness.', { exact: true })
    .waitFor();
  const issueLink = page.getByRole('link', { name: 'GitHub · example/service#42' });
  assert.equal(
    await issueLink.getAttribute('href'),
    'https://github.com/example/service/issues/42',
  );
  assert.equal(await issueLink.getAttribute('target'), '_blank');
  await page.getByRole('tab', { name: 'Live terminals', exact: true }).click();
  await page
    .getByRole('region', { name: 'Live terminals', exact: true })
    .getByText('No workspace yet.', { exact: false })
    .waitFor();
  assert.equal(await page.locator('#terminal-run').count(), 0);
  const contextEditor = page.locator('[data-editor="task-message"]');
  await contextEditor.locator('textarea').fill('## Context still here');
  await contextEditor.getByRole('tab', { name: 'Preview', exact: true }).click();
  if (localApp) {
    localApp.store.event(parseTaskRoute(new URL(page.url()).hash).id, {
      type: 'configuration',
      summary: 'Refresh fixture',
    });
    await page.waitForTimeout(700);
  }
  await contextEditor.getByRole('heading', { name: 'Context still here', exact: true }).waitFor();
  assert.equal(await contextEditor.locator('textarea').inputValue(), '## Context still here');

  for (const kind of ['paste', 'drop']) {
    await page.locator('#task-message').evaluate(
      (input, { kind, bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(bytes)], `${kind}-screenshot.png`, { type: 'image/png' }),
        );
        const event =
          kind === 'paste'
            ? new ClipboardEvent('paste', {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
      },
      { kind, bytes: [...photo] },
    );
    await page.waitForFunction(
      () => !document.querySelector('[data-editor="task-message"][data-uploading]'),
    );
    assert.ok(
      (await page.locator('#task-message').inputValue()).includes(
        `![${kind}-screenshot](/api/attachments/`,
      ),
    );
  }
  await page.getByRole('button', { name: 'Send direction', exact: false }).click();
  await page.waitForFunction(() => document.querySelector('#task-message')?.value === '');
  await assertReadableText(page);
  await page.screenshot({ path: join(screenshots, 'task-description.png'), fullPage: true });

  // Edit a saved draft, render GFM safely, and retain task-local configuration.
  await page.getByRole('button', { name: 'Configure task', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.locator('#edit-title').fill('Configurable draft');
  const source =
    '# Requirements\n\n**Bold** and _italic_.\n\n- [x] Investigate\n- [ ] Implement\n\n> Keep compatibility.\n\n```js\nconst n = 1;\n```\n\n| Field | Value |\n| --- | --- |\n| mode | strict |\n\n[Reference](https://example.com)\n\n<script>window.previewInjected = true</script>\n\n[bad](javascript:alert(1))\n\n<img src=x onerror="window.previewInjected=true">';
  await editor.locator('#edit-description').fill(source);
  const descriptionEditor = editor.locator('[data-editor="edit-description"]');
  await descriptionEditor.getByRole('tab', { name: 'Preview', exact: true }).click();
  await descriptionEditor.getByRole('heading', { name: 'Requirements', exact: true }).waitFor();
  assert.equal(await descriptionEditor.locator('table tbody tr').count(), 1);
  assert.equal(await descriptionEditor.locator('input[type=checkbox][disabled]').count(), 2);
  assert.equal(await descriptionEditor.locator('pre code').textContent(), 'const n = 1;\n');
  assert.equal(await descriptionEditor.locator('script,img,svg,iframe').count(), 0);
  assert.equal(await descriptionEditor.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.previewInjected), undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('dialog').scrollWidth <=
        document.querySelector('dialog').clientWidth,
    ),
    'Markdown editor must fit on mobile',
  );
  await assertReadableText(page);
  await page.screenshot({ path: join(screenshots, 'mobile-markdown-preview.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await descriptionEditor.getByRole('tab', { name: 'Write', exact: true }).click();
  assert.equal(await editor.locator('#edit-description').inputValue(), source);
  // Validate file attachment, in-flight edits, safe external images, and a nested viewer.
  await page.route('**/api/attachments', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await descriptionEditor
    .locator('input[type=file]')
    .setInputFiles({ name: 'expected-behavior.png', mimeType: 'image/png', buffer: photo });
  await page.waitForFunction(() =>
    document.querySelector('[data-editor="edit-description"][data-uploading]'),
  );
  await editor.getByRole('button', { name: 'Save task settings', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Wait for the image uploads to finish' })
    .waitFor();
  await editor
    .locator('#edit-description')
    .fill('Edited during upload.\n\n' + (await editor.locator('#edit-description').inputValue()));
  await editor.locator('#edit-description').evaluate((input) => input.setSelectionRange(0, 0));
  await page.waitForFunction(
    () => !document.querySelector('[data-editor="edit-description"][data-uploading]'),
  );
  assert.equal(
    await editor.locator('#edit-description').evaluate((input) => input.selectionStart),
    0,
  );
  const withUpload = await editor.locator('#edit-description').inputValue();
  assert.ok(withUpload.startsWith('Edited during upload.'));
  assert.ok(withUpload.includes('![expected-behavior](/api/attachments/'));
  await page.unroute('**/api/attachments');
  await editor
    .locator('#edit-description')
    .fill(
      withUpload +
        '\n\n![External screenshot](https://images.example.test/example.png)\n\n<img src="https://images.example.test/html.png" alt="HTML screenshot" width="960" onerror="window.previewInjected=true">\n\n![Unsafe](javascript:alert(1))\n\n![Inline SVG](data:image/svg+xml,test)\n\n![Local secrets](/api/bootstrap)',
    );
  await descriptionEditor.getByRole('tab', { name: 'Preview', exact: true }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-editor="edit-description"] img')].length === 3 &&
      [...document.querySelectorAll('[data-editor="edit-description"] img')].every(
        (image) => image.complete && image.naturalWidth === 960,
      ),
  );
  assert.equal(externalReferrer, undefined);
  assert.equal(
    await descriptionEditor
      .locator('img[src^="data:"],img[src^="javascript:"],img[src$="/api/bootstrap"]')
      .count(),
    0,
  );
  assert.equal(await descriptionEditor.locator('img[onerror],img[onclick],img[srcset]').count(), 0);
  assert.equal(await page.evaluate(() => window.previewInjected), undefined);
  const beforeViewer = await editor.locator('#edit-description').inputValue();
  await descriptionEditor
    .getByRole('button', { name: 'Enlarge image: expected-behavior', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Image preview', exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, 'image-viewer.png'), fullPage: false });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#edit-description').inputValue(), beforeViewer);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('#dialog').scrollWidth <=
        document.querySelector('#dialog').clientWidth,
    ),
    'Embedded images must fit the mobile editor',
  );
  await assertReadableText(page);
  await page.screenshot({ path: join(screenshots, 'mobile-image-preview.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Rejected and failed uploads leave the written content intact and allow retry.
  await descriptionEditor.locator('input[type=file]').setInputFiles({
    name: 'unsafe.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  });
  assert.equal(await editor.locator('#edit-description').inputValue(), beforeViewer);
  await page.route('**/api/attachments', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Upload fixture failure' }),
    }),
  );
  await descriptionEditor
    .locator('input[type=file]')
    .setInputFiles({ name: 'failed.png', mimeType: 'image/png', buffer: photo });
  await page.waitForFunction(
    () => !document.querySelector('[data-editor="edit-description"][data-uploading]'),
  );
  assert.ok(!(await editor.locator('#edit-description').inputValue()).includes('relay-upload:'));
  assert.ok((await editor.locator('#edit-description').inputValue()).includes('expected-behavior'));
  await page.unroute('**/api/attachments');

  await editor.locator('[name="route-review"]').selectOption('codex', { force: true });
  await editor.locator('[name="model-review"]').fill('review-model');
  await editor.locator('[name="timeoutMinutes"]').fill('22');
  await editor.locator('[name="maxRepairRounds"]').fill('5');
  await editor.getByText('Browser fixture · checks & guidance', { exact: true }).click();
  await editor.locator('textarea[name$="-checks"]').fill('["node","--version"]');
  await editor.getByRole('button', { name: 'Save task settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Configurable draft', exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Description and requirements', exact: true })
    .getByRole('heading', { name: 'Requirements', exact: true })
    .waitFor();

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.task-description img')].length === 3 &&
      [...document.querySelectorAll('.task-description img')].every(
        (image) => image.complete && image.naturalWidth === 960,
      ),
  );
  await page.screenshot({ path: join(screenshots, 'task-embedded-images.png'), fullPage: true });
  const editedUrl = page.url();
  await page.reload();
  await page.getByRole('button', { name: 'Configure task', exact: true }).click();
  assert.equal(await editor.locator('[name="model-review"]').inputValue(), 'review-model');
  assert.equal(await editor.locator('[name="timeoutMinutes"]').inputValue(), '22');
  assert.equal(await editor.locator('[name="maxRepairRounds"]').inputValue(), '5');
  await assertReadableText(page);
  await page.screenshot({ path: join(screenshots, 'task-configuration.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Duplicate task', exact: true }).click();
  await editor.locator('#new-title').fill('Draft duplicate');
  await editor.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByRole('heading', { name: 'Draft duplicate', exact: true }).waitFor();
  assert.notEqual(page.url(), editedUrl);
  await page.getByRole('button', { name: 'All tasks', exact: false }).first().click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.locator('#task-stage-filter').selectOption('backlog', { force: true });
  assert.equal(await page.locator('.task-list-row').count(), 2);
  await page.locator('#task-search').fill('Configurable draft');
  assert.equal(await page.locator('.task-list-row').count(), 1);
  await page.locator('.task-list-open').click();
  await page.getByRole('heading', { name: 'Configurable draft', exact: true }).waitFor();
  await page.waitForURL((url) => url.hash.startsWith('#task/'));
  await page.goBack();
  await page.locator('#task-search').waitFor();
  assert.equal(await page.locator('#task-search').inputValue(), 'Configurable draft');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await page.locator('#task-stage-filter').inputValue(), '');
  assert.equal(await page.locator('#task-search').inputValue(), '');
  await page.screenshot({ path: join(screenshots, 'task-list.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Task list must fit on mobile',
  );
  await assertReadableText(page);
  await page.screenshot({ path: join(screenshots, 'mobile-task-list.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });

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
        verificationMode: 'commands',
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
    await page.locator('#new-repository').selectOption('client', { force: true });
    await page.getByText('Coordinate additional repositories', { exact: true }).click();
    await page.locator('input[name="additionalRepository"][value="service"]').check();
    await page.getByRole('listbox', { name: 'Prerequisites for client' }).selectOption(['service']);
    await page.locator('#new-title').fill('Upgrade service and client');
    await page.getByRole('button', { name: 'Create task', exact: false }).click();
    await page.getByRole('button', { name: 'Start workflow' }).click();
    await page.getByRole('heading', { name: 'Choose the way forward.' }).waitFor();
    await page.getByRole('tab', { name: 'Live terminals', exact: true }).click();
    await page.getByRole('button', { name: 'Configure task', exact: true }).click();
    assert.equal(await page.locator('#edit-repository').isDisabled(), true);
    assert.equal(await page.locator('textarea[name=repo-service-setup]').isDisabled(), true);
    await page
      .getByRole('dialog')
      .getByText('Your worktree and history are preserved.', { exact: false })
      .waitFor();
    await page.keyboard.press('Escape');
    const originalShell = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    await page.getByRole('button', { name: 'Take over · service', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Take control', exact: true })
      .click();
    await page.getByRole('heading', { name: 'You have control', exact: true }).waitFor();
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    await page.getByRole('heading', { name: 'Your shell', exact: true }).waitFor();
    await page.getByText('Connected · type directly below', { exact: true }).waitFor();
    const terminal = page.getByRole('textbox', { name: 'Interactive terminal', exact: true });
    await terminal.focus();
    await page.keyboard.type('printf browser-input-verifieX');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('d > terminal-proof.txt');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('.xterm-rows')?.textContent.includes('browser-input-verified'),
    );
    const manualTask = localApp.store.get(parseTaskRoute(new URL(page.url()).hash).id);
    const manualWorkspace = manualTask.repositories.find(
      (r) => r.repository.id === 'service',
    ).workspace;
    await assertEventuallyFile(
      join(manualWorkspace, 'terminal-proof.txt'),
      'browser-input-verified',
    );
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.keyboard.type('sleep 60');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
    await terminal.focus();
    await page.keyboard.type('printf after-interrupt > interrupt-proof.txt');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('.xterm-rows')?.textContent.includes('after-interrupt'),
    );
    await assertEventuallyFile(join(manualWorkspace, 'interrupt-proof.txt'), 'after-interrupt');
    await page.evaluate(() => {
      const paste = new ClipboardEvent('paste', {
        clipboardData: new DataTransfer(),
        bubbles: true,
      });
      paste.clipboardData.setData('text/plain', 'printf pasted-unicode-é > paste-proof.txt');
      document.querySelector('.xterm-helper-textarea').dispatchEvent(paste);
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('.xterm-rows')?.textContent.includes('pasted-unicode-é'),
    );
    await assertEventuallyFile(join(manualWorkspace, 'paste-proof.txt'), 'pasted-unicode-é');
    await page.screenshot({ path: join(screenshots, 'interactive-terminal.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'Manual terminal must fit on mobile',
    );
    await assertReadableText(page);
    await page.screenshot({ path: join(screenshots, 'manual-terminal.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole('button', { name: 'Return to automation', exact: true }).click();
    await page.getByRole('heading', { name: 'Choose the way forward.' }).waitFor();
    await page.getByRole('button', { name: 'Approve & implement' }).click();
    await page.getByRole('heading', { name: 'The specialists are done. Over to you.' }).waitFor();
    assert.equal(
      await page.locator('.task-context').getByText('WORKSPACE', { exact: true }).count(),
      2,
    );
    await page.getByRole('tab', { name: 'Code changes' }).click();
    await page.getByText('2 repository diffs', { exact: true }).waitFor();
    assert.equal(await page.locator('.repository-diff').count(), 2);
    await page
      .getByRole('button', { name: /Comment on contract.txt line/ })
      .first()
      .click();
    await page.locator('#line-comment').fill('Check empty values at this boundary.');
    await page.getByRole('button', { name: 'Save inline comment', exact: true }).click();
    await page.getByText('Check empty values at this boundary.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Mark resolved', exact: true }).click();
    await page
      .getByRole('button', { name: /Comment on contract.txt line/ })
      .first()
      .click();
    await page.locator('#line-comment').fill('Preserve the cross-repository contract.');
    await page.getByRole('button', { name: 'Save inline comment', exact: true }).click();
    await page
      .getByRole('button', { name: 'Send all open comments for repair', exact: true })
      .click();
    await page.waitForFunction(async () => {
      const id = location.hash.slice('#task/'.length).split('/')[0];
      const task = await fetch(`/api/tasks/${id}`).then((r) => r.json());
      return (
        task.status === 'awaiting_final' &&
        task.attempts.filter((a) => a.stage === 'implement' && a.status === 'complete').length >= 4
      );
    });
    await page.getByRole('button', { name: 'Configure task', exact: true }).waitFor();

    await page.getByRole('heading', { name: 'The specialists are done. Over to you.' }).waitFor();
    await page.getByRole('button', { name: 'Refresh all', exact: true }).click();
    await page.getByText('Preserve the cross-repository contract.', { exact: true }).waitFor();
    assert.equal(
      localApp.store.get(parseTaskRoute(new URL(page.url()).hash).id).reviewComments.length,
      2,
    );
    await page.screenshot({ path: join(screenshots, 'inline-feedback.png'), fullPage: true });
    await page.getByRole('button', { name: 'Accept result', exact: true }).click();
    await page.locator('.task-subtitle .badge.completed').waitFor();
    await page
      .getByRole('heading', { name: 'From accepted changes to a PR', exact: true })
      .waitFor();
    const publicationTask = localApp.store.get(parseTaskRoute(new URL(page.url()).hash).id);
    publicationTask.repositories[0].publication = {
      url: 'https://code.example/team/project/pull/42',
      title: 'Observed PR',
      number: '42',
      state: 'open',
      draft: true,
      checks: 'pending',
      review: 'required',
      checkedAt: new Date().toISOString(),
      summary: 'CI is running',
      evidence: ['Read provider status'],
    };
    publicationTask.repositories[0].publicationMonitor = { enabled: false, status: 'paused' };
    localApp.store.save(publicationTask);
    await page.getByRole('button', { name: 'Refresh all', exact: true }).click();
    await page.getByRole('link', { name: 'Observed PR ↗', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Observed PR ↗', exact: true }).getAttribute('href'),
      'https://code.example/team/project/pull/42',
    );
    await page.getByText('CI is running', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'View technical details', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('heading', { name: 'Branch and commit' }).waitFor();
    await page.keyboard.press('Escape');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page
        .locator('.publication-panel')
        .screenshot({ path: join(screenshots, `delivery-${width}.png`) });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    assert.equal(
      await page.getByRole('button', { name: 'Publish draft PR', exact: true }).count(),
      1,
    );
    await page.getByRole('button', { name: 'Publish draft PR', exact: true }).first().click();
    await page
      .getByRole('dialog')
      .getByText('Each repository is published separately.', { exact: false })
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
      await page.locator('.task-context').getByText('WORKSPACE', { exact: true }).count(),
      2,
    );
  }
  if (localApp) {
    const historyTask = newTask(
      { title: 'Investigate retry history', repositoryId: 'service' },
      localApp.store.config,
    );
    historyTask.status = 'blocked';
    historyTask.workspace = join(fixture, 'history-workspace');
    historyTask.attempts = Array.from({ length: 10 }, (_, i) => ({
      id: `history-${i}`,
      harness: 'codex',
      stage: 'investigate',
      status: 'complete',
      terminal: {},
      startedAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
      handoff: {
        ...demoHandoff(historyTask, 'investigate'),
        verdict: 'blocked',
        summary: `Run ${i + 1} found a runtime blocker.`,
      },
    }));
    localApp.store.save(historyTask);
    for (const kind of ['message', 'message', 'output'])
      localApp.store.event(historyTask.id, {
        attemptId: 'history-9',
        type: 'activity',
        kind,
        summary: kind === 'output' ? '{"protocol":"raw payload"}' : 'Checked the retry boundary.',
      });
    await page.goto(`${origin}/#task/${historyTask.id}`);
    await page.getByRole('tab', { name: 'Live terminals', exact: true }).click();
    await page
      .getByRole('region', { name: 'Selected run', exact: true })
      .getByText('Run 10 found a runtime blocker.', { exact: true })
      .waitFor();
    const picker = page.locator('#terminal-run');
    assert.equal(await picker.locator('option').count(), 10);
    assert.equal(await page.locator('.terminal-tabs').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Follow latest', exact: true }).count(), 0);
    assert.equal(
      await page.getByLabel('Terminal output preview', { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await page
        .locator('.terminal-run-summary')
        .getByText('Checked the retry boundary.', { exact: true })
        .count(),
      1,
    );
    await picker.selectOption('history-0', { force: true });
    await page
      .getByRole('region', { name: 'Selected run', exact: true })
      .getByText('Run 1 found a runtime blocker.', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Go to latest run', exact: true }).click();
    await page
      .getByRole('region', { name: 'Selected run', exact: true })
      .getByText('Run 10 found a runtime blocker.', { exact: true })
      .waitFor();
    await page.locator('.terminal-raw > summary').click();
    await page
      .getByLabel('Terminal output preview', { exact: true })
      .getByText('raw payload', { exact: false })
      .waitFor();
    await page.getByRole('button', { name: 'Open execution log', exact: true }).click();
    assert.equal(await page.locator('#log-run').inputValue(), 'history-9');
    await page.getByRole('tab', { name: 'Live terminals', exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await assertReadableText(page);
      await page
        .getByRole('region', { name: 'Live terminals', exact: true })
        .screenshot({ path: join(screenshots, `terminal-run-history-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole('button', { name: 'Approval inbox', exact: true }).click();
    await page.getByRole('heading', { name: 'Approval inbox', exact: true }).waitFor();
    await assertReadableText(page);
    await page.getByRole('button', { name: 'Harnesses', exact: true }).click();
    await page.getByRole('heading', { name: 'Routing evidence', exact: true }).waitFor();
    await page.locator('#outcomes-repository').selectOption('service', { force: true });
    await page.getByRole('heading', { name: 'Suggested defaults', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh storage', exact: true }).click();
    await page.getByRole('heading', { name: 'Backup and restore', exact: true }).waitFor();
    await assertReadableText(page);
    await page.getByRole('button', { name: 'Create downloadable backup', exact: true }).click();
    await page.getByRole('heading', { name: 'Backup ready', exact: true }).waitFor();
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download private archive', exact: true }).click();
    const downloaded = await downloading;
    const archivePath = await downloaded.path();
    assert.ok(archivePath);
    await page.keyboard.press('Escape');
    await page.locator('#backup-file').setInputFiles(archivePath);
    await page.getByRole('button', { name: 'Inspect backup', exact: true }).click();
    await page.getByRole('heading', { name: 'Review this restore', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Restore this backup', exact: true }).click();
    await page.getByRole('heading', { name: 'Backup restored', exact: true }).waitFor();
    await page
      .getByRole('link', { name: 'Download pre-restore safety backup', exact: true })
      .waitFor();
    await page.screenshot({ path: join(screenshots, 'backup-restore.png'), fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(localApp.engine.running.size, 0);
    assert.ok(
      localApp.store.all().every((t) => !['running', 'queued', 'manual'].includes(t.status)),
    );
  }
  if (localApp) {
    const debugTask = localApp.engine.create({
      title: 'Choose a diagnostic direction',
      demo: true,
    });
    debugTask.status = 'blocked';
    debugTask.stage = 'implement';
    debugTask.error = 'Fixture identity import failed';
    debugTask.attempts = [
      {
        id: 'run-a',
        stage: 'implement',
        harness: 'codex',
        status: 'complete',
        startedAt: new Date(Date.now() - 90000).toISOString(),
        finishedAt: new Date(Date.now() - 60000).toISOString(),
        handoff: {
          summary: 'Implementation preserved',
          details: 'Waiting for runtime',
          verdict: 'blocked',
        },
      },
      {
        id: 'run-b',
        parentAttemptId: 'run-a',
        relation: 'Diagnosis',
        role: 'debug',
        stage: 'implement',
        harness: 'codex',
        status: 'complete',
        handoff: {
          summary: 'Runtime investigated',
          details: 'Recorded evidence',
          evidence: ['Isolated check attempted'],
          verdict: 'complete',
        },
      },
      {
        id: 'run-c',
        parentAttemptId: 'run-b',
        relation: 'Continue after diagnosis',
        stage: 'implement',
        harness: 'codex',
        status: 'complete',
        handoff: { summary: 'Checks retried', verdict: 'blocked' },
      },
    ];
    debugTask.blockerDecision = {
      id: 'debug-decision',
      summary: 'Fixture identity import failed in the configured runtime.',
      explanation: 'The isolated check reproduced the failure; source was preserved.',
      required: ['Choose a supported runtime or request a revised approach.'],
      evidence: [
        'Isolated fixture test failed before identity creation.',
        'Existing runtime was queried without changing security settings.',
      ],
      options: [
        {
          id: 'runtime',
          title: 'Use another supported runtime',
          description: 'Reproduce the documented check in a working runtime.',
          tradeoffs: 'Preserves the current source change.',
        },
      ],
      debugAttempts: 2,
      resolved: false,
    };
    localApp.store.save(debugTask, {
      type: 'decision',
      summary: debugTask.blockerDecision.summary,
    });
    await page.goto(`${origin}/#task/${debugTask.id}`);
    await page.getByRole('region', { name: 'Blocker decision', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Activity thread', exact: true }).click();
    assert.ok(page.url().endsWith(`/thread`));
    await page.reload();
    await page.getByRole('tab', { name: 'Activity thread', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('tab', { name: 'Activity thread', exact: true })
        .getAttribute('aria-selected'),
      'true',
    );
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.goBack();
    await page.getByRole('tab', { name: 'Activity thread', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('tab', { name: 'Activity thread', exact: true })
        .getAttribute('aria-selected'),
      'true',
    );
    await page.getByRole('button', { name: 'Open execution graph', exact: false }).click();
    await page.getByRole('region', { name: 'Execution graph', exact: true }).waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.screenshot({
        path: join(screenshots, `execution-node-graph-${width}.png`),
        fullPage: true,
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.getByRole('button', { name: 'Close execution graph', exact: true }).click();

    await page.getByRole('button', { name: 'Ask on the side', exact: false }).click();
    await page.locator('#side-question').fill('What is blocked?');
    await page.getByRole('button', { name: 'Ask without interrupting', exact: true }).click();
    await page.getByText('Side answer: What is blocked?', { exact: true }).waitFor();
    assert.equal(localApp.store.get(debugTask.id).status, 'blocked');
    assert.equal(localApp.store.get(debugTask.id).messages.length, 0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await assertReadableText(page);
      await page.screenshot({
        path: join(screenshots, `side-chat-drawer-${width}.png`),
        fullPage: true,
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.getByRole('button', { name: 'Close side conversation', exact: true }).click();
    await page.getByText('What needs your input', { exact: true }).waitFor();
    await page.getByText('Full requirements & evidence', { exact: false }).click();
    await page
      .getByText('Isolated fixture test failed before identity creation.', { exact: true })
      .waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await assertReadableText(page);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        JSON.stringify(
          await page.evaluate(() =>
            [...document.querySelectorAll('body *')]
              .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
              .map((el) => ({
                tag: el.tagName,
                class: el.className,
                width: el.getBoundingClientRect().width,
              }))
              .slice(0, 15),
          ),
        ),
      );
      await page.screenshot({
        path: join(screenshots, `blocker-decision-${width}.png`),
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Revise approach', exact: true }).click();
    await page.getByRole('heading', { name: 'Choose the way forward.', exact: true }).waitFor();
    assert.equal(localApp.store.get(debugTask.id).chosenApproach, null);
    assert.equal(localApp.store.get(debugTask.id).approvals.length, 0);
  }
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Browser checks passed: approvals, task editing and duplication, GFM preview and sanitization, image uploads/paste/drop/viewer, live refresh, filters, history, terminals, inbox, routing evidence, inline repairs, backup/restore, and mobile contrast/layout.\n',
  );
} finally {
  await browser?.close();
  await localApp?.close();
  await rm(fixture, { recursive: true, force: true });
}

async function assertEventuallyFile(path, expected) {
  for (let i = 0; i < 100; i++) {
    if ((await readFile(path, 'utf8').catch(() => '')) === expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(await readFile(path, 'utf8'), expected);
}
