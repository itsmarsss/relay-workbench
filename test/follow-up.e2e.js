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
    sideAnswer: async ({ question, followUp }) => {
      if (!followUp) return 'The implementation and review context are available.';
      return {
        action:
          question === 'Shorten the PR description'
            ? 'publication'
            : question === 'Add a focused regression case'
              ? 'changes'
              : 'question',
        answer:
          question === 'Explain the accepted implementation'
            ? 'The implementation and review context are available.'
            : 'I am starting the requested follow-up.',
        repositoryId: question === 'Shorten the PR description' ? 'repo' : '',
      };
    },
    publicationPublish: async ({ task }) => {
      publicationRequest = task.publicationContext.followUpRequest;
      return {
        verdict: 'complete',
        summary: 'Updated PR details',
        details: 'Existing PR metadata updated',
        evidence: ['Read back PR metadata'],
        risks: [],
        options: [],
        publication: pr,
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
  await page.locator('#follow-up-message').fill('Keep this draft while the page updates');
  app.store.event(task.id, { type: 'publication', summary: 'A background status refresh' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[name="followup-mode"]').count(), 0);
  assert.equal(
    await page.locator('#follow-up-message').inputValue(),
    'Keep this draft while the page updates',
  );
  assert.equal(await page.getByRole('button', { name: 'Send request', exact: true }).count(), 1);
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
  await page.locator('#follow-up-message').fill('Explain the accepted implementation');
  await page
    .locator('#follow-up-form')
    .getByRole('button', { name: 'Send request', exact: true })
    .click();
  await page
    .locator('.side-chat-response')
    .filter({ hasText: 'implementation and review context' })
    .waitFor();
  assert.equal(app.store.get(task.id).status, 'completed');
  await page.getByRole('button', { name: 'Close side conversation', exact: true }).click();
  await page.locator('#follow-up-message').fill('Shorten the PR description');
  await page
    .locator('#follow-up-form')
    .getByRole('button', { name: 'Send request', exact: true })
    .click();
  for (let i = 0; i < 200 && app.store.get(task.id).delivery?.status !== 'complete'; i++)
    await page.waitForTimeout(25);
  assert.equal(publicationRequest, 'Shorten the PR description');
  assert.equal(
    app.store.get(task.id).delivery.status,
    'complete',
    app.store.get(task.id).delivery.details,
  );
  await page.getByRole('button', { name: 'Close side conversation', exact: true }).click();
  await page.locator('#follow-up-message').fill('Add a focused regression case');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose an approach', exact: true }).waitFor();
  assert.equal(app.store.get(task.id).workspace, repo);
  assert.equal(app.store.get(task.id).status, 'awaiting_plan');
  assert.equal(app.store.get(task.id).followUps.length, 1);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'Follow-up browser checks passed: questions, edit approval, PR updates, live drafts, workflow status, and responsive layout.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
