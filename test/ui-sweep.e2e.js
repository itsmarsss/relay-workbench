import { mockDiscovery } from './discovery-fixtures.js';
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
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function check(name, width) {
    await assertReadableText(page);
    if (await page.locator('.detail-tabs').count()) {
      assert.ok(
        await page.locator('.detail-tabs').evaluate((bar) => {
          const selected = bar.querySelector('[aria-selected=true]').getBoundingClientRect();
          const indicator = bar.querySelector('[data-tab-indicator]').getBoundingClientRect();
          return bar.clientHeight <= 44 && Math.abs(indicator.bottom - selected.bottom) < 3;
        }),
        'Tab selection remains aligned in a single row',
      );
    }
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
    assert.equal(
      await page.locator('.description-toggle').isVisible(),
      false,
      'Short descriptions need no expansion control',
    );
    await page.getByText('Verification not recorded', { exact: true }).waitFor();
    assert.ok(
      await page
        .locator('.task-heading')
        .evaluate((el) => el.getBoundingClientRect().height < (innerWidth > 1100 ? 160 : 260)),
      'Task header stays compact',
    );
    assert.ok(
      await page.locator('.follow-up-footer').evaluate((row) => {
        const submit = row.querySelector('button[type=submit]').getBoundingClientRect();
        const controls = [...row.querySelectorAll('relay-select')].map((host) =>
          host.shadowRoot.querySelector('.select-trigger').getBoundingClientRect(),
        );
        return (
          controls.every((box) => Math.abs(box.height - submit.height) < 1) &&
          (innerWidth < 650 || controls.every((box) => Math.abs(box.bottom - submit.bottom) < 1))
        );
      }),
      'Run agent matches adjacent control heights and desktop alignment',
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

    for (const tab of ['thread', 'terminals', 'handoffs', 'diff', 'transcript', 'overview']) {
      const target = page.locator(`[role=tab][data-action=tab][data-tab=${tab}]`);
      if (!(await target.count())) continue;
      await target.click();
      if (tab === 'handoffs') {
        assert.equal(await target.locator('span').innerText(), '9');
        assert.equal(
          await page.locator('.handoff-card').first().locator('.verdict').innerText(),
          'Complete',
        );
      }
      await check(`task-${tab}`, width);
    }
    await page
      .getByRole('button', { name: 'Open execution graph', exact: true })
      .scrollIntoViewIfNeeded();
    const pageScroll = await page.evaluate(() => scrollY);
    await page.getByRole('button', { name: 'Open execution graph', exact: true }).click();
    assert.equal(
      await page.evaluate(() => scrollY),
      pageScroll,
      'Opening the graph preserves page position',
    );
    await page.getByRole('dialog', { name: 'Execution graph', exact: true }).waitFor();
    const dialog = page.getByRole('dialog', { name: 'Execution graph', exact: true });
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).overflowY),
      'hidden',
    );
    await page.mouse.move(2, 2);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => scrollY), pageScroll, 'Graph blocks document scrolling');
    assert.ok(await page.locator('.sidebar').evaluate((el) => el.inert));
    const insideGraph = () =>
      page.evaluate(() => !!document.activeElement.closest('.graph-dialog'));
    assert.ok(await insideGraph(), 'Opening the graph moves focus inside');
    await dialog.getByRole('button', { name: 'Latest run', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.ok(await insideGraph(), 'Backward tabbing stays inside the graph');
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await insideGraph(), 'Forward tabbing stays inside the graph');
    }
    await page.keyboard.press('n');
    assert.equal(
      await page.locator('#dialog[open]').count(),
      0,
      'Background new-task shortcut is suspended',
    );
    assert.equal(await page.locator('.graph-lane-title').count(), 3);
    await page.getByRole('button', { name: 'Fit view', exact: true }).click();
    await check('graph', width);
    await page.evaluate(() => {
      window.graphScrollBehaviors = [];
      const viewport = document.querySelector('.node-graph-scroll');
      const scrollTo = viewport.scrollTo.bind(viewport);
      viewport.scrollTo = (options) => {
        window.graphScrollBehaviors.push(options.behavior);
        scrollTo(options);
      };
    });
    await page.getByRole('button', { name: 'Readable view', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Reset zoom', exact: true }).innerText(),
      '100%',
    );
    await page.waitForFunction(() => {
      const node = document.querySelector('.graph-node.selected');
      const box = node.getBoundingClientRect();
      const viewport = node.closest('.node-graph-scroll').getBoundingClientRect();
      return (
        box.left >= viewport.left &&
        box.right <= viewport.right &&
        box.top >= viewport.top &&
        box.bottom <= viewport.bottom
      );
    });
    assert.equal(await page.evaluate(() => window.graphScrollBehaviors.at(-1)), 'smooth');
    await page.evaluate(async () => (await import('/motion-preferences.js')).setLowMotion(true));
    await page.getByRole('button', { name: 'Latest run', exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.graphScrollBehaviors.at(-1)),
      'instant',
      'Low motion focuses immediately',
    );
    await page.evaluate(async () => (await import('/motion-preferences.js')).setLowMotion(false));
    assert.ok(
      await page.locator('.graph-node.selected').evaluate((node) => {
        const box = node.getBoundingClientRect();
        const viewport = node.closest('.node-graph-scroll').getBoundingClientRect();
        return (
          box.left >= viewport.left &&
          box.right <= viewport.right &&
          box.top >= viewport.top &&
          box.bottom <= viewport.bottom
        );
      }),
      'Readable view centers the selected node inside the graph viewport',
    );
    assert.equal(
      await page.evaluate(() => scrollY),
      pageScroll,
      'Focusing a run does not scroll the page',
    );
    await page.getByRole('button', { name: 'Previous run', exact: true }).click();
    await page.locator('.graph-inspector h3').filter({ hasText: 'Independent review' }).waitFor();
    await page.getByRole('button', { name: 'Next run', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Next run', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await page.locator('.graph-node').nth(4).click();
    await page.locator('.graph-inspector h3').filter({ hasText: 'Debugger' }).waitFor();
    await check('graph-detail', width);
    await page.getByRole('button', { name: 'Close execution graph', exact: true }).click();
    assert.ok(
      await page.locator('.workflow-graph-button').evaluate((el) => el === document.activeElement),
      'Closing restores focus to the opener',
    );
    assert.equal(await page.locator('.sidebar').evaluate((el) => el.inert), false);
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.documentElement).overflowY),
      'hidden',
    );
    await page.getByRole('button', { name: 'PR details for Example project', exact: true }).click();
    await page.locator('dialog .pr-detail-link').waitFor();
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).overflowY),
      'hidden',
    );
    const modalScroll = await page.evaluate(() => scrollY);
    await page.mouse.move(2, 2);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(() => scrollY),
      modalScroll,
      'Modal blocks document scrolling',
    );
    await page.locator('dialog .feedback-status').waitFor();
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
  task.title =
    'Coordinate validation and compatibility across a very long multi-repository workflow without losing important implementation context';
  task.description =
    '## Requirements\n\n' +
    'Preserve compatibility across all affected surfaces while documenting the alternatives and evidence. '.repeat(
      18,
    ) +
    '\n\n### Boundary cases\n\n- Keep existing callers working.\n- Validate changes with focused checks.';
  task.attempts[4].handoff.evidence = Array.from(
    { length: 12 },
    (_, i) =>
      `Evidence ${i + 1}: ` + 'A detailed observation for a long diagnostic run. '.repeat(10),
  );
  app.store.save(task);
  for (const [width, theme] of [
    [390, 'dark'],
    [1440, 'light'],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#task/${task.id}/overview`);
    await page.evaluate((theme) => window.RelayTheme.set(theme), theme);
    await page.locator('.completion-brief').waitFor();
    assert.equal(
      await page.locator('.task-summary').count(),
      0,
      'Accepted tasks omit duplicate context cards',
    );
    const expansion = page.getByRole('button', { name: 'Expand description', exact: true });
    await expansion.waitFor();
    await expansion.click();
    assert.equal(await page.locator('.description-toggle').getAttribute('aria-expanded'), 'true');
    assert.ok(
      await page
        .locator('.task-description')
        .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      'Expanded descriptions expose the full content',
    );
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    assert.equal(
      await page.locator('.description-toggle').getAttribute('aria-expanded'),
      'true',
      'Live reconciliation preserves expansion',
    );
    await page.getByRole('button', { name: 'Collapse description', exact: true }).click();
    assert.ok(await page.locator('.task-description').evaluate((el) => el.clientHeight <= 420));
    await check('dense-task', width);
    await page.getByRole('button', { name: 'Open execution graph', exact: true }).click();
    await page.locator('.graph-node').nth(4).click();
    await page.locator('.graph-inspector .detail-disclosure').first().locator('summary').click();
    await check('dense-graph', width);
    await page.keyboard.press('Escape');
    assert.equal(
      await page.getByRole('dialog', { name: 'Execution graph', exact: true }).count(),
      0,
    );
    assert.equal(await page.locator('.sidebar').evaluate((el) => el.inert), false);
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.documentElement).overflowY),
      'hidden',
    );
  }
  let diffState = 'error';
  await page.route(`**/api/tasks/${task.id}/diff`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        diffState === 'error'
          ? { error: 'Workspace preview failed. ' + 'Detailed diagnostic output. '.repeat(60) }
          : { text: '', untracked: [], stat: '', fingerprint: 'empty' },
      ),
    }),
  );
  for (const width of [1440, 390]) {
    diffState = 'error';
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/#task/${task.id}/diff`);
    await page.getByRole('heading', { name: 'Couldn’t load changes', exact: true }).waitFor();
    assert.equal(await page.locator('.diff-load-error details').getAttribute('open'), null);
    await page.getByText('Error details', { exact: true }).click();
    await check('changes-error', width);
    diffState = 'empty';
    await page.getByRole('button', { name: 'Retry loading changes', exact: true }).click();
    await page.getByRole('heading', { name: 'No changes yet', exact: true }).waitFor();
    assert.equal(await page.locator('.diff-file-toolbar').count(), 0);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'No changes yet', exact: true }).waitFor();
    await check('changes-empty', width);
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
