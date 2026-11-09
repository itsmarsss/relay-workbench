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
    marker = join(temporary, 'started');
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
  const line = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(handoff) },
  });
  const output = `cat >/dev/null\nprintf '%s\\n' '${line}'\n`;
  await writeFile(agent, `#!/bin/sh\n${output}`, { mode: 0o700 });
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
      env: { ...gitEnv, RELAY_E2E_MARKER: marker },
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
  const headers = { 'Content-Type': 'application/json', 'X-Relay-Token': bootstrap.token };
  const config = bootstrap.config;
  config.harnesses.codex.command = agent;
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
        routing: { investigate: 'codex', plan: 'codex' },
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
  await page.goto(`${base}/#task/${first.id}/overview`);
  await page.getByRole('button', { name: 'Start investigation' }).click();
  await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
  assert.equal(await page.getByRole('heading', { name: /Small change/ }).count(), 1);
  assert.equal(await page.getByText('Recommended', { exact: true }).count(), 1);
  response = await fetch(`${base}/api/tasks/${first.id}/approve-plan`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(response.status, 405, 'implementation cannot bypass the unfinished approval gate');
  const firstTask = await (await fetch(`${base}/api/tasks/${first.id}`)).json();
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

  await writeFile(agent, `#!/bin/sh\ntouch "$RELAY_E2E_MARKER"\nsleep 30\n${output}`, {
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
  await writeFile(agent, `#!/bin/sh\n${output}`, { mode: 0o700 });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('heading', { name: 'Proposed approaches' }).waitFor({ timeout: 45000 });
  const resumed = await (await fetch(`${base}/api/tasks/${second.id}`)).json();
  assert.equal(resumed.workspaceRoot, paused.workspaceRoot);
  assert.equal(
    await readFile(join(resumed.workspaceRoot, 'setup.txt'), 'utf8'),
    'preserve changes',
  );
  assert.deepEqual(errors, []);
  console.log(
    'React/Go workflow: isolated start, activity, approval gate, pause and resume passed.',
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
