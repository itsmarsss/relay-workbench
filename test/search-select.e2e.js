import { mockDiscovery } from './discovery-fixtures.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
const { chromium } = await import('playwright');
const directory = await mkdtemp(join(tmpdir(), 'relay-controls-'));
const app = createApp({ directory, publicDirectory: resolve('public') });
let browser;
try {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await mockDiscovery(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/Content Security Policy/.test(message.text())) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.getByRole('heading', { name: /Let’s make progress/ }).waitFor();
  await page.evaluate(async () => {
    const { updateLiveDOM } = await import('/live-dom.js');
    const { handoffBody } = await import('/task-panels.js');
    document.querySelector('#app').remove();
    const root = document.createElement('main');
    root.id = 'controls-fixture';
    root.className = 'task-center';
    root.style.maxWidth = '900px';
    root.style.margin = '24px auto';
    root.style.padding = '16px';
    document.body.append(root);
    const report = {
      risks: [
        'One unresolved prerequisite needs evidence.',
        'Review required before publishing.',
        'A full explanation of the third risk remains available.',
      ],
      files: ['repo/src/interpreter/other_of_other.rs'],
      details: 'The full explanation remains available here.',
      evidence: ['Executed the required repository checks.'],
      findings: [
        {
          severity: 'major',
          file: 'repo::packages/long-project-name/library/src/internal/an_extremely_long_source_file_name.rs:345',
          description:
            'The alias can select the wrong column. Confirm the boundary behavior with an executable regression test.',
        },
      ],
    };
    window.renderControls = (count = 0) =>
      updateLiveDOM(
        root,
        `<h1>Report & controls</h1><form id="controls-form"><label for="fixture-select">Repository</label><select id="fixture-select" name="repository" required><option value="">Choose a repository</option><option value="alpha">Alpha service</option><option value="beta">Beta client</option><option value="disabled" disabled>Disabled repository</option>${Array.from({ length: count }, (_, i) => `<option value="extra-${i}">Extra repository ${i}</option>`).join('')}</select><button type="submit">Save selection</button></form><details class="report-section" data-event-key="test-report" open><summary>Run details &amp; evidence</summary>${handoffBody(report)}</details><dialog id="controls-dialog"><form><label for="modal-select">Model</label><select id="modal-select"><option value="first">First model</option><option value="second">Second model</option></select><button type="button" id="close-controls-dialog">Close fixture dialog</button></form></dialog>`,
        'controls',
      );
    window.renderControls();
    window.selectionChanges = 0;
    root.addEventListener('change', () => window.selectionChanges++);
    root.addEventListener('submit', (event) => {
      event.preventDefault();
      window.savedSelection = new FormData(event.target).get('repository');
    });
  });
  const picker = page.locator('relay-select').filter({ has: page.locator('#fixture-select') });
  const trigger = picker.getByRole('combobox', { name: 'Repository', exact: true });
  await trigger.click();
  const search = picker.getByRole('combobox', { name: 'Search Repository', exact: true });
  await search.fill('beta');
  assert.equal(await picker.getByRole('option').count(), 1);
  await search.press('Enter');
  assert.equal(await page.locator('#fixture-select').inputValue(), 'beta');
  assert.equal(await page.evaluate(() => window.selectionChanges), 1);
  await page.getByRole('button', { name: 'Save selection', exact: true }).click();
  assert.equal(await page.evaluate(() => window.savedSelection), 'beta');
  await trigger.click();
  await search.fill('nothing matches');
  await picker.getByRole('status').getByText('No matching options').waitFor();
  assert.equal(
    await page.locator('dialog[open]').count(),
    0,
    'Typing n must not invoke the global new-task shortcut',
  );
  await search.fill('disabled');
  await picker.getByRole('option', { name: 'Disabled repository' }).click({ force: true });
  assert.equal(await page.locator('#fixture-select').inputValue(), 'beta');
  await search.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await trigger.focus();
  await trigger.press('ArrowDown');
  await search.fill('alpha');
  await search.press('Enter');
  assert.equal(await page.locator('#fixture-select').inputValue(), 'alpha');
  await trigger.click();
  await search.fill('extra');
  await page.evaluate(() => window.renderControls(50));
  assert.equal(await search.inputValue(), 'extra');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await picker.getByRole('option').count(), 50);
  await search.press('ArrowDown');
  await search.press('Enter');
  assert.equal(await page.locator('#fixture-select').inputValue(), 'extra-1');
  await trigger.click();
  await search.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent.trim()),
    'Save selection',
  );
  await page.evaluate(() => (document.querySelector('#fixture-select').disabled = true));
  assert.equal(await trigger.isDisabled(), true);
  await page.evaluate(() => {
    document.querySelector('#fixture-select').disabled = false;
    document.querySelector('#controls-dialog').showModal();
  });
  const modal = page.locator('#controls-dialog');
  await modal.getByRole('combobox', { name: 'Model', exact: true }).click();
  await modal.getByRole('combobox', { name: 'Search Model', exact: true }).fill('second');
  await modal.getByRole('option', { name: 'Second model' }).click();
  assert.equal(await page.locator('#modal-select').inputValue(), 'second');
  await page.evaluate(() => document.querySelector('#controls-dialog').close());
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await trigger.click();
    const bounds = await picker.locator('.select-popover').boundingBox();
    assert.ok(
      bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
      'Dropdown must fit the viewport',
    );
    await search.press('Escape');
    const severity = page.locator('.report-findings .severity');
    const rect = await severity.boundingBox();
    assert.ok(rect.width > rect.height, 'Severity remains a horizontal badge');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({
      path: `docs/screenshots/report-controls-${width}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Searchable controls browser checks passed: filtering, keyboard, disabled/empty states, forms, live refresh, modal focus, viewport bounds and report hierarchy.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
