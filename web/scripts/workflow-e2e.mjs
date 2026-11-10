import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const goRoot = resolve(webRoot, '..', 'go');
const temporary = await mkdtemp(join(tmpdir(), 'relay-react-go-e2e-'));
let server, browser;
let serverOutput = '';
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0 || result.error)
    throw new Error(
      `${command} failed: ${result.stderr || result.error?.message || result.stdout}`,
    );
}
async function port() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const value = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (failure) {
      error = failure;
    }
    if (server?.exitCode !== null) throw new Error(`Preview exited: ${serverOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${error?.message || serverOutput}`);
}
try {
  const repo = join(temporary, 'repo'),
    binary = join(temporary, 'relay-go');
  await mkdir(repo);
  run('git', ['init', '-q'], repo);
  await writeFile(join(repo, 'source.txt'), 'base\n');
  run('git', ['add', 'source.txt'], repo);
  run('git', ['commit', '-q', '-m', 'test: fixture'], repo);
  await writeFile(join(repo, 'source.txt'), 'local work stays here\n');
  run('go', ['build', '-o', binary, './cmd/relay-go'], goRoot);
  const agent = join(temporary, 'fake-agent'),
    marker = join(temporary, 'started'),
    failedOnce = join(temporary, 'failed-once'),
    debugMarker = join(temporary, 'debugged'),
    decisionRelease = join(temporary, 'decision-release');
  const issueProvider = join(temporary, 'issue-provider');
  const importedIssue = {
    title: 'Imported title',
    body: 'Imported issue body',
    url: 'https://example.test/issues/42',
    author: { login: 'reporter' },
    comments: [{ body: 'Full discussion context', author: { login: 'reviewer' } }],
  };
  await writeFile(
    issueProvider,
    `#!/usr/bin/env node\nrequire('node:child_process').spawnSync('/bin/sleep', ['0.2']);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(importedIssue))});\n`,
    { mode: 0o700 },
  );
  const handoff = {
    memorySuggestions: [],
    summary: 'Fixture investigation complete',
    details: 'Reviewed the fixture.',
    files: ['source.txt'],
    evidence: ['Inspected fixture'],
    risks: [],
    options: [
      {
        id: 'a',
        title: 'Small change',
        description: 'Change the affected behavior.',
        tradeoffs: 'A focused change.',
      },
    ],
    recommendedOptionId: 'a',
    recommendationReason: 'It is the simplest complete option.',
    findings: [],
    verdict: 'complete',
    routing: { investigate: 'codex', plan: 'codex', implement: 'codex', review: 'codex' },
  };
  const agentProgram = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const prompt = fs.readFileSync(0, 'utf8');
const handoff = ${JSON.stringify(handoff)};
const debugging = prompt.includes('You are a debugger.');
const diagnosis = prompt.includes('"title":"Needs diagnosis"');
const decision = prompt.includes('"title":"Needs decision"');
if (debugging && (diagnosis || decision)) spawnSync('/bin/sleep', ['1']);
if (diagnosis && !debugging && !fs.existsSync(process.env.RELAY_E2E_DEBUG_MARKER)) {
  fs.writeFileSync(process.env.RELAY_E2E_DEBUG_MARKER, 'blocked');
  handoff.verdict = 'blocked'; handoff.summary = 'Specialist could not resolve the blocker';
}
if (decision && !fs.existsSync(process.env.RELAY_E2E_DECISION_RELEASE)) {
  handoff.verdict = 'blocked'; handoff.summary = 'A decision is required';
}
if (debugging && diagnosis) handoff.summary = 'Debugger identified a workable path';
if (prompt.includes('Implement the approved approach')) fs.writeFileSync('source.txt', 'implemented\\n');
if (prompt.includes('SUPERVISED VERIFICATION:')) {
  const helper = JSON.parse(prompt.slice(prompt.lastIndexOf('\\n') + 1));
  const cwd = fs.realpathSync(process.cwd());
  const command = process.execPath;
  const repair = prompt.includes('"title":"Repair loop"');
  const persistent = prompt.includes('"title":"Persistent failure"');
  const failing = persistent || (repair && !fs.existsSync(process.env.RELAY_E2E_FAILED_ONCE));
  if (failing && repair) fs.writeFileSync(process.env.RELAY_E2E_FAILED_ONCE, 'failed');
  const args = ['-e', failing ? 'process.exit(7)' : 'console.log("checked the changed surface")'];
  const check = spawnSync(helper.executable, [...helper.prefix, '--repository', 'fixture', '--cwd', cwd, '--', command, ...args], { encoding: 'utf8' });
  if (check.stdout) process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);
  if (check.status !== (failing ? 7 : 0)) process.exit(check.status || 1);
  handoff.verification = { checks: [{ repositoryId: 'fixture', cwd, command, args, code: check.status, summary: failing ? 'Focused check failed' : 'Focused check passed' }], requirements: [{ repositoryId: 'fixture', source: 'fixture instructions', requirement: 'Check changed behavior', checkIndices: [0] }], reuse: [] };
}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(handoff) } }));
`;
  await writeFile(agent, agentProgram, { mode: 0o700 });
  const listenPort = await port(),
    base = `http://127.0.0.1:${listenPort}`;
  server = spawn(
    binary,
    [
      '--data-dir',
      join(temporary, 'state'),
      '--web-dir',
      join(webRoot, 'dist'),
      '--port',
      String(listenPort),
    ],
    {
      cwd: goRoot,
      env: {
        ...gitEnv,
        RELAY_E2E_MARKER: marker,
        RELAY_E2E_FAILED_ONCE: failedOnce,
        RELAY_E2E_DEBUG_MARKER: debugMarker,
        RELAY_E2E_DECISION_RELEASE: decisionRelease,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (value) => {
    serverOutput += value;
  });
  server.stderr.on('data', (value) => {
    serverOutput += value;
  });
  await until(async () => (await fetch(`${base}/api/health`)).ok, 'preview server');
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(bootstrap.workflowPreview, true);
  assert.equal(bootstrap.implementationPreview, true);
  assert.equal(bootstrap.debugRecoveryPreview, true);
  assert.equal(bootstrap.issueImportPreview, true);
  const headers = { 'Content-Type': 'application/json', 'X-Relay-Token': bootstrap.token };
  const config = bootstrap.config;
  config.harnesses.codex.command = agent;
  config.harnesses.claude.enabled = false;
  config.harnesses.pi.enabled = false;
  config.repositories = [
    {
      id: 'fixture',
      name: 'Fixture',
      path: repo,
      cwd: '.',
      strategy: 'worktree',
      verificationMode: 'agent',
      checks: [],
      setup: [{ command: '/bin/sh', args: ['-c', 'printf setup > setup.txt'] }],
      instructions: '',
      issueCommand: { command: issueProvider, args: ['{ticket}'] },
    },
  ];
  let response = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { ...headers, 'If-Match': bootstrap.configRevision },
    body: JSON.stringify(config),
  });
  assert.equal(response.status, 200, await response.text());
  async function draft(title) {
    const result = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title,
        repositoryId: 'fixture',
        routing: { investigate: 'codex', plan: 'codex', implement: 'codex', review: 'codex' },
      }),
    });
    assert.equal(result.status, 201, await result.clone().text());
    return result.json();
  }
  const first = await draft('Preview workflow');
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RELAY_CHROME ? { executablePath: process.env.RELAY_CHROME } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/#tasks`);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const composer = page.getByRole('dialog', { name: 'New task' });
  await composer.getByLabel('Title', { exact: true }).fill('Keep my title');
  await composer.getByLabel('Description', { exact: true }).fill('Keep my note');
  await composer.getByLabel('Issue link or reference').fill('42');
  await composer.getByRole('checkbox', { name: /Fixture/ }).check();
  await composer.getByRole('button', { name: 'Import issue context' }).click();
  await until(
    async () =>
      (await composer.getByLabel('Description', { exact: true }).inputValue()).includes(
        'Full discussion context',
      ),
    'issue context import',
  );
  const importedDescription = await composer
    .getByLabel('Description', { exact: true })
    .inputValue();
  assert.ok(
    importedDescription.includes('Keep my note') &&
      importedDescription.includes('Filed by: **reporter**'),
  );
  assert.equal(await composer.getByLabel('Title', { exact: true }).inputValue(), 'Keep my title');
  await composer.getByRole('button', { name: 'Import issue context' }).click();
  await composer.getByRole('button', { name: 'Importing…' }).waitFor();
  await composer.getByRole('button', { name: 'Import issue context' }).waitFor();
  assert.equal(
    await composer.getByLabel('Description', { exact: true }).inputValue(),
    importedDescription,
  );
  await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(`${base}/#task/${first.id}/overview`);
  await page.getByRole('button', { name: 'Start investigation' }).click();
  await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
  assert.equal(await page.getByRole('heading', { name: /Small change/ }).count(), 1);
  assert.equal(await page.getByText('Recommended', { exact: true }).count(), 1);
  response = await fetch(`${base}/api/tasks/${first.id}/approve-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ optionId: 'a' }),
  });
  assert.equal(response.status, 403, 'approval must require the local session token');
  const firstTask = await (await fetch(`${base}/api/tasks/${first.id}`)).json();
  const planAttempt = firstTask.attempts.findLast((attempt) => attempt.stage === 'plan');
  response = await fetch(`${base}/api/tasks/${first.id}/approve-plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      optionId: 'a',
      planAttemptId: planAttempt.id,
      taskRevision: firstTask.taskRevision,
      automation: true,
    }),
  });
  assert.equal(response.status, 400, 'approval cannot inject automation authority');
  assert.equal(firstTask.status, 'awaiting_plan');
  assert.equal(firstTask.approvals.length, 0);
  assert.equal(await readFile(join(repo, 'source.txt'), 'utf8'), 'local work stays here\n');
  assert.ok(
    (await realpath(firstTask.workspaceRoot)).startsWith(await realpath(join(temporary, 'state'))),
  );
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page
    .getByText('Fixture investigation complete', { exact: true })
    .first()
    .waitFor({ timeout: 10000 });

  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('radio', { name: 'Select Small change' }).check();
  await page.getByRole('button', { name: 'Approve approach' }).click();
  await page.getByRole('heading', { name: 'Ready for your review' }).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: 'View changes' }).click();
  await page
    .locator('.diff-code .addition')
    .filter({ hasText: '+implemented' })
    .waitFor({ timeout: 10000 });
  const reviewed = await (await fetch(`${base}/api/tasks/${first.id}`)).json();
  assert.equal(reviewed.status, 'awaiting_final');
  assert.ok(reviewed.verifiedFingerprint);
  assert.equal(reviewed.reviewedFingerprint, reviewed.verifiedFingerprint);
  assert.ok(
    reviewed.attempts.some((run) => run.stage === 'verify' && run.verificationEvidence?.length),
  );
  await page.getByRole('button', { name: 'Accept result' }).click();
  await until(
    async () =>
      (await (await fetch(`${base}/api/tasks/${first.id}`)).json()).status === 'completed',
    'final acceptance',
  );
  assert.equal(await readFile(join(repo, 'source.txt'), 'utf8'), 'local work stays here\n');

  await writeFile(agent, `#!/bin/sh\ntouch "$RELAY_E2E_MARKER"\nsleep 30\n`, {
    mode: 0o700,
  });
  const second = await draft('Pause and resume');
  await page.goto(`${base}/#task/${second.id}/overview`);
  await page.getByRole('button', { name: 'Start investigation' }).click();
  await until(async () => {
    try {
      await readFile(marker);
      return true;
    } catch {
      return false;
    }
  }, 'agent start');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor({ timeout: 15000 });
  const paused = await (await fetch(`${base}/api/tasks/${second.id}`)).json();
  assert.equal(paused.status, 'paused');
  await writeFile(join(paused.workspaceRoot, 'setup.txt'), 'preserve changes');
  await writeFile(agent, agentProgram, { mode: 0o700 });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
  const resumed = await (await fetch(`${base}/api/tasks/${second.id}`)).json();
  assert.equal(resumed.workspaceRoot, paused.workspaceRoot);
  assert.equal(
    await readFile(join(resumed.workspaceRoot, 'setup.txt'), 'utf8'),
    'preserve changes',
  );

  // Take over from the browser, type into the PTY, then return control.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Take control' })
    .getByRole('button', { name: 'Open terminal' })
    .click();
  await page.getByText('You have control', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByLabel('Interactive terminal', { exact: true }).focus();
  await page.keyboard.type('printf terminal-ok > manual.txt');
  await page.keyboard.press('Enter');
  await until(async () => {
    try {
      return (await readFile(join(resumed.workspaceRoot, 'manual.txt'), 'utf8')) === 'terminal-ok';
    } catch {
      return false;
    }
  }, 'browser terminal input');
  await page.getByRole('button', { name: 'Return control', exact: true }).click();
  await until(
    async () => (await (await fetch(`${base}/api/tasks/${second.id}`)).json()).status === 'paused',
    'manual release',
  );
  assert.equal(await readFile(join(resumed.workspaceRoot, 'manual.txt'), 'utf8'), 'terminal-ok');
  async function approveTask(title) {
    const created = await draft(title);
    await page.goto(`${base}/#task/${created.id}/overview`);
    await page.getByRole('button', { name: 'Start investigation' }).click();
    await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
    await page.getByRole('radio', { name: 'Select Small change' }).check();
    await page.getByRole('button', { name: 'Approve approach' }).click();
    return created.id;
  }
  const repairID = await approveTask('Repair loop');
  await page.getByRole('heading', { name: 'Ready for your review' }).waitFor({ timeout: 45000 });
  const repaired = await (await fetch(`${base}/api/tasks/${repairID}`)).json();
  assert.equal(repaired.round, 1);
  assert.equal(repaired.attempts.filter((attempt) => attempt.stage === 'implement').length, 2);
  assert.equal(repaired.attempts.filter((attempt) => attempt.stage === 'verify').length, 2);
  assert.equal(
    repaired.attempts.some((attempt) => attempt.role === 'debug'),
    false,
  );

  const failingID = await approveTask('Persistent failure');
  const blocked = await until(
    async () => {
      const task = await (await fetch(`${base}/api/tasks/${failingID}`)).json();
      return task.status === 'blocked' ? task : null;
    },
    'bounded repair',
    45000,
  );
  assert.match(blocked.error, /Repair limit reached/);
  assert.equal(blocked.round, 4);
  assert.equal(blocked.attempts.filter((attempt) => attempt.stage === 'verify').length, 4);
  assert.equal(
    blocked.attempts.some((attempt) => attempt.role === 'debug'),
    false,
  );

  const diagnosis = await draft('Needs diagnosis');
  await page.goto(`${base}/#task/${diagnosis.id}/overview`);
  await page.getByRole('button', { name: 'Start investigation' }).click();
  await page.getByText(/Debugger running/).waitFor({ timeout: 20000 });
  await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
  const diagnosed = await (await fetch(`${base}/api/tasks/${diagnosis.id}`)).json();
  assert.equal(diagnosed.attempts[0].handoff.verdict, 'blocked');
  assert.equal(diagnosed.attempts[1].role, 'debug');
  assert.equal(diagnosed.attempts[2].stage, 'investigate');
  assert.equal(diagnosed.attempts[3].stage, 'plan');

  const decisionTask = await draft('Needs decision');
  await page.goto(`${base}/#task/${decisionTask.id}/overview`);
  await page.getByRole('button', { name: 'Start investigation' }).click();
  await page.getByRole('heading', { name: 'Needs your decision' }).waitFor({ timeout: 45000 });
  await page.getByRole('radio', { name: 'Select Small change' }).check();
  await page.getByLabel('Direction (optional)').fill('Use the newly available capability.');
  await writeFile(decisionRelease, 'ready');
  await page.getByRole('button', { name: 'Retry debugger' }).click();
  await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
  const resolved = await (await fetch(`${base}/api/tasks/${decisionTask.id}`)).json();
  assert.ok(resolved.attempts.filter((attempt) => attempt.role === 'debug').length >= 3);
  assert.ok(
    resolved.messages.some(
      (message) =>
        message.text.includes('newly available capability') && message.delivery === 'delivered',
    ),
  );
  // Restore a plan choice into a separate task without losing later edits.
  await page.goto(`${base}/#task/${first.id}/overview`);
  const originalFinal = await (await fetch(`${base}/api/tasks/${first.id}`)).json();
  await writeFile(join(originalFinal.workspaceRoot, 'source.txt'), 'preserve later edits\n');
  await page.getByRole('button', { name: /^Checkpoints/ }).click();
  const checkpointDialog = page.getByRole('dialog', { name: 'Continue from a checkpoint' });
  await checkpointDialog.getByRole('button', { name: 'Continue with', exact: true }).click();
  await page
    .getByRole('option', { name: 'Choose a different saved approach', exact: true })
    .click();
  await checkpointDialog.getByRole('button', { name: 'Create continuation' }).click();
  await until(
    async () => /#task\/(?!${first.id})/.test(page.url()) && !page.url().includes(first.id),
    'continuation navigation',
  );
  await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
  const forkID = page.url().match(/#task\/([^/]+)/)[1];
  const restored = await until(async () => {
    const t = await (await fetch(`${base}/api/tasks/${forkID}`)).json();
    return t.checkpointRestore?.status === 'complete' ? t : null;
  }, 'checkpoint restore');
  assert.notEqual(restored.workspaceRoot, originalFinal.workspaceRoot);
  assert.equal(
    await readFile(join(originalFinal.workspaceRoot, 'source.txt'), 'utf8'),
    'preserve later edits\n',
  );
  assert.equal(restored.verifiedFingerprint, undefined);
  assert.equal(restored.chosenApproach, null);
  // Auto is an explicit task-scoped delegation, separate from ordinary approval.
  const automatic = await draft('Automatic fixture');
  await page.goto(`${base}/#task/${automatic.id}/overview`);
  await page.getByRole('button', { name: 'Auto off', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Authorize Auto mode' })
    .getByRole('button', { name: 'Authorize for this task' })
    .click();
  await page.getByRole('button', { name: 'Auto on', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start investigation' }).click();
  const automated = await until(
    async () => {
      const t = await (await fetch(`${base}/api/tasks/${automatic.id}`)).json();
      return t.status === 'completed' ? t : null;
    },
    'delegated workflow',
    45000,
  );
  assert.equal(automated.approvals.length, 2);
  assert.ok(automated.approvals.every((a) => a.automation?.authorizationId));
  assert.deepEqual(errors, []);
  console.log(
    'React/Go workflow: issue import, approval, verification, repair, debugger recovery, blocker decisions, review, diff, acceptance, pause and resume passed.',
  );
} catch (error) {
  if (serverOutput) console.error(serverOutput);
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!server.kill('SIGKILL')) resolve();
      }, 10000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(temporary, { recursive: true, force: true });
}
