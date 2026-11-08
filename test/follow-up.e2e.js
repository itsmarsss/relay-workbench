import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { DEFAULT_CONFIG } from '../server/domain.js';
import { demoHandoff } from '../server/harness.js';
import { git, fingerprint } from '../server/workspace.js';
import { chromium } from 'playwright';
const directory = await mkdtemp(join(tmpdir(), 'relay-followup-browser-'));
const repo = join(directory, 'repo');
await mkdir(repo);
await git(repo, ['init', '-b', 'feature/follow-up']);
await writeFile(join(repo, 'value.txt'), 'accepted\n');
await git(repo, ['add', '.']);
await git(repo, [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'test: accepted fixture',
]);
let publicationRequest;
const pr = {
  url: 'https://code.example/team/repo/pull/42',
  number: '42',
  title: 'Accepted work',
  state: 'open',
  draft: true,
  checks: 'passing',
  review: 'approved',
};
const app = createApp({
  directory: join(directory, 'state'),
  publicDirectory: resolve('public'),
  engineOptions: {
    harness: async ({ task, stage }) => demoHandoff(task, stage),
    sideAnswer: async () => 'A read-only side answer.',
    followUpRun: async ({ task, harness, onEvent }) => {
      assert.equal(harness, 'claude');
      onEvent({ type: 'activity', kind: 'message', summary: 'Working on the follow-up request.' });
      if (task.followUpRequest === 'Shorten the PR description')
        publicationRequest = task.followUpRequest;
      return {
        ...demoHandoff(task, 'investigate'),
        summary:
          task.followUpRequest === 'Explain the accepted implementation'
            ? 'The implementation and review context are available.'
            : 'Requested follow-up finished',
        details: 'The selected agent inspected the context and completed the requested work.',
        followUpAction:
          task.followUpRequest === 'Add a focused regression case' ? 'changes' : 'complete',
      };
    },
    publicationObserve: async () => ({ publication: pr }),
  },
});
let browser;
try {
  app.store.setConfig({
    ...DEFAULT_CONFIG,
    repositories: [
      {
        id: 'repo',
        name: 'Example',
        path: repo,
        cwd: '.',
        strategy: 'attach',
        verificationMode: 'commands',
        setup: [],
        checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
        instructions: '',
      },
    ],
  });
  const task = app.engine.create({ title: 'Completed work with follow-up', repositoryId: 'repo' });
  Object.assign(task, {
    status: 'completed',
    stage: 'review',
    workspace: repo,
    workspaceRoot: repo,
    baseCommit: await git(repo, ['rev-parse', 'HEAD']),
    branch: 'feature/follow-up',
    publication: pr,
    setupCompleted: true,
  });
  task.acceptedFingerprint = task.reviewedFingerprint = await fingerprint(task);
  task.attempts = [
    {
      id: 'verified',
      stage: 'verify',
      role: 'verifier',
      harness: 'codex',
      status: 'complete',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:02:00Z',
      handoff: { verdict: 'complete', summary: 'Checks passed' },
    },
  ];
  task.sideQuestions = [
    {
      id: 'historical-followup',
      question: 'A historical follow-up',
      answer: 'The previous requested update was recorded.',
      followUp: true,
      action: 'publication',
      status: 'complete',
      stage: 'review',
      createdAt: new Date().toISOString(),
      toolCalls: [
        { id: 'schema', name: 'StructuredOutput', status: 'complete' },
        {
          id: 'read',
          name: 'mcp__relay_source__read_file',
          input: { path: 'value.txt' },
          status: 'complete',
        },
      ],
    },
  ];
  app.store.save(task);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#task/${task.id}/overview`);
  await page.getByRole('region', { name: 'Continue work', exact: true }).waitFor();
  const stage = page.locator('.workflow-stage').filter({ hasText: 'Verification agent' });
  assert.equal(await stage.getAttribute('data-stage-state'), 'complete');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.locator('#follow-up-message').fill('Keep this draft while the page updates');
  app.store.event(task.id, { type: 'publication', summary: 'A background status refresh' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[name="followup-mode"]').count(), 0);
  assert.equal(
    await page.locator('#follow-up-message').inputValue(),
    'Keep this draft while the page updates',
  );
  assert.equal(await page.getByRole('button', { name: 'Run agent', exact: true }).count(), 1);
  if (process.env.RELAY_VISUAL_DIR) {
    await mkdir(process.env.RELAY_VISUAL_DIR, { recursive: true });
    await page.screenshot({
      path: join(process.env.RELAY_VISUAL_DIR, 'follow-up-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(process.env.RELAY_VISUAL_DIR, 'follow-up-mobile.png'),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),
      true,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  // Historical routed messages must not break the drawer's DOM or reflow the page.
  const before = await page.locator('.task-center').evaluate((el) => ({
    x: el.getBoundingClientRect().x,
    width: el.getBoundingClientRect().width,
  }));
  await page.getByRole('button', { name: 'Ask Relay', exact: false }).click();
  assert.equal(await page.locator('.side-chat-drawer > form#side-question-form').count(), 1);
  assert.equal(await page.locator('.task-context > #side-question-form').count(), 0);
  assert.equal(await page.getByText('StructuredOutput', { exact: true }).count(), 0);
  const after = await page.locator('.task-center').evaluate((el) => ({
    x: el.getBoundingClientRect().x,
    width: el.getBoundingClientRect().width,
  }));
  assert.deepEqual(after, before);
  await page.getByRole('button', { name: 'Close side conversation', exact: true }).click();
  for (const request of ['Explain the accepted implementation', 'Shorten the PR description']) {
    const count = app.store.get(task.id).deliveryRuns?.length ?? 0;
    await page.locator('#follow-up-message').fill(request);
    await page.getByRole('button', { name: 'Run agent', exact: true }).click();
    for (
      let i = 0;
      i < 200 &&
      ((app.store.get(task.id).deliveryRuns?.length ?? 0) <= count ||
        app.store.get(task.id).deliveryRuns?.at(-1)?.status !== 'complete');
      i++
    )
      await page.waitForTimeout(25);
    assert.equal(app.store.get(task.id).deliveryRuns.at(-1).status, 'complete');
    assert.equal(app.store.get(task.id).deliveryRuns.at(-1).harness, 'claude');
    assert.equal(await page.locator('.side-chat-drawer').count(), 0);
    assert.ok(page.url().endsWith('/thread'));
    assert.equal(app.store.get(task.id).sideQuestions.length, 1);
  }
  assert.equal(publicationRequest, 'Shorten the PR description');
  await page.locator('#follow-up-message').fill('Add a focused regression case');
  await page.getByRole('button', { name: 'Run agent', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose an approach', exact: true }).waitFor();
  assert.equal(app.store.get(task.id).workspace, repo);
  assert.equal(app.store.get(task.id).status, 'awaiting_plan');
  assert.equal(app.store.get(task.id).followUps.length, 1);
  assert.equal(app.store.get(task.id).routing.plan, 'claude');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'Follow-up browser checks passed: questions, edit approval, PR updates, live drafts, workflow status, and responsive layout.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
