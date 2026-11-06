import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
