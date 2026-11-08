import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { demoHandoff } from '../server/harness.js';
import { createApp } from '../server/app.js';
const { chromium } = await import('playwright');
const directory = await mkdtemp(join(tmpdir(), 'relay-live-dom-'));
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.getByRole('heading', { name: /Let’s make progress/ }).waitFor();
  // A stalled activity request must not hide a completed stage or approval gate.
  const task = app.engine.create({ title: 'Live approval transition', demo: true });
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#task/${task.id}/overview`);
  await page.getByRole('heading', { name: task.title, exact: true }).waitFor();
  let releaseEvents;
  const heldEvents = new Promise((resolve) => {
    releaseEvents = resolve;
  });
  await page.route(`**/api/tasks/${task.id}/events?*`, async (route) => {
    await heldEvents;
    await route.continue().catch(() => {});
  });
  task.status = 'awaiting_plan';
  task.stage = 'plan';
  const plan = demoHandoff(task, 'plan');
  plan.options[0].description =
    'Preserve behavior.\n\n- Read `src/example.js`\n- **Confirm** the result with [evidence](https://example.com).\n\n<script>alert(1)</script>';
  plan.options[0].tradeoffs = '- Less runtime risk.\n- More test upkeep.';
  task.attempts.push({
    id: 'completed-plan',
    stage: 'plan',
    status: 'complete',
    handoff: plan,
  });
  app.store.save(task, { type: 'handoff', summary: 'Plan ready for approval' });
  await page.getByRole('heading', { name: 'Choose an approach' }).waitFor({ timeout: 8000 });
  assert.equal(
    await page.locator('.approach-description code').first().innerText(),
    'src/example.js',
  );
  assert.ok(await page.locator('.approach-description ul').count());
  assert.equal(await page.locator('.approach-description script').count(), 0);
  assert.ok(await page.locator('.approach-tradeoffs ul').count());
  releaseEvents();
  await page.unroute(`**/api/tasks/${task.id}/events?*`);
  // Polling also refreshes non-task pages when the event stream is unavailable.
  await page.route('**/api/events', (route) => route.abort());
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#tasks`);
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  const polled = app.engine.create({ title: 'Visible without event stream', demo: true });
  await page
    .locator(`[data-action="open-task"][data-id="${polled.id}"]`)
    .waitFor({ timeout: 12000 });
  // A failed diff remains retryable, and a slow Git snapshot gets more than 10 seconds.
  let diffRequests = 0;
  await page.route(`**/api/tasks/${task.id}/diff`, async (route) => {
    diffRequests++;
    if (diffRequests === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary snapshot failure' }),
      });
    await new Promise((resolve) => setTimeout(resolve, 11000));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        text: 'diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-before\n+after\n',
        stat: '1 file changed',
        untracked: [],
        fingerprint: 'example',
      }),
    });
  });
  task.demo = false;
  task.workspace = directory;
  app.store.save(task);
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#task/${task.id}/overview`);
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Retry loading changes', exact: true }).click();
  await page.locator('.diff-file').waitFor({ timeout: 20000 });
  assert.equal(diffRequests, 2);
  assert.equal(await page.locator('.error-panel').count(), 0);
  const result = await page.evaluate(async () => {
    const { updateLiveDOM } = await import('/live-dom.js');
    document.querySelector('#app').remove();
    const root = document.createElement('main');
    document.body.append(root);
    const markup = (count, prefix = '') =>
      `${prefix}<div id="spacer">${'<p>Earlier output</p>'.repeat(45)}</div><article data-event-seq="1"><details data-event-key="run"><summary>Run</summary><details class="report-section"><summary>Evidence (${count})</summary><p id="evidence">Saved evidence</p><input id="draft" value="initial"><pre id="output" class="terminal-preview">${'output\n'.repeat(40)}</pre></details></details></article><article data-event-seq="2"><p>Latest output ${count}</p></article>${'<p>Later output</p>'.repeat(40)}`;
    updateLiveDOM(root, markup(1), 'task:one:thread');
    const run = root.querySelector('details');
    const nested = root.querySelector('.report-section');
    run.open = true;
    nested.open = true;
    const draft = root.querySelector('#draft');
    draft.value = 'Unsent direction';
    draft.focus();
    draft.setSelectionRange(3, 8);
    const output = root.querySelector('#output');
    // Use an existing stylesheet scroll region; no inline style permissions needed.
    output.scrollTop = 100;
    root.querySelector('#evidence').scrollIntoView({ block: 'center' });
    const oldTop = root.querySelector('#evidence').getBoundingClientRect().top;
    for (let count = 2; count < 12; count++) updateLiveDOM(root, markup(count), 'task:one:thread');
    const preserved = {
      run: root.querySelector('details') === run && run.open,
      nested: root.querySelector('.report-section') === nested && nested.open,
      input: root.querySelector('#draft') === draft && draft.value === 'Unsent direction',
      focus:
        document.activeElement === draft && draft.selectionStart === 3 && draft.selectionEnd === 8,
      nestedScroll: output.scrollTop === 100 && root.querySelector('#output') === output,
      scroll: Math.abs(root.querySelector('#evidence').getBoundingClientRect().top - oldTop) < 2,
    };
    nested.open = false;
    updateLiveDOM(root, markup(12), 'task:one:thread');
    preserved.closed = !nested.open && root.querySelector('.report-section') === nested;
    nested.open = true;
    root.querySelector('article').scrollIntoView({ block: 'start' });
    const anchor = root.querySelector('article');
    const anchorTop = anchor.getBoundingClientRect().top;
    updateLiveDOM(
      root,
      markup(13, '<section><p>Inserted status</p><p>More status</p></section>'),
      'task:one:thread',
    );
    preserved.anchor =
      root.querySelector('article') === anchor &&
      Math.abs(anchor.getBoundingClientRect().top - anchorTop) < 2;
    updateLiveDOM(root, markup(14), 'task:two:thread');
    preserved.scope = root.querySelector('details') !== run && !root.querySelector('details').open;
    // Existing xterm content must never be reconciled as application markup.
    updateLiveDOM(root, '<div data-browser-terminal><span>Owned by xterm</span></div>', 'terminal');
    const terminal = root.firstChild;
    terminal.append(document.createElement('textarea'));
    updateLiveDOM(root, '<div data-browser-terminal></div>', 'terminal');
    preserved.terminal = root.firstChild === terminal && !!terminal.querySelector('textarea');
    const controls =
      '<div><button data-action="markdown-tab" data-mode="write">Write</button><button data-action="markdown-tab" data-mode="preview">Preview</button></div>';
    updateLiveDOM(root, controls, 'editor');
    const write = root.querySelector('[data-mode="write"]');
    const preview = root.querySelector('[data-mode="preview"]');
    for (let count = 0; count < 5; count++) updateLiveDOM(root, controls, 'editor');
    preserved.editorControls =
      root.querySelector('[data-mode="write"]') === write &&
      root.querySelector('[data-mode="preview"]') === preview;
    return preserved;
  });
  for (const [check, passed] of Object.entries(result))
    assert.ok(passed, `Live DOM must preserve ${check}`);
  console.log('Live DOM browser checks passed:', Object.keys(result).join(', '));
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
