import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { FollowUpAgent } from '../server/follow-up-agent.js';
import { DEFAULT_CONFIG, executionConfig } from '../server/domain.js';
import { git } from '../server/workspace.js';
import { demoHandoff, buildPrompt } from '../server/harness.js';
async function fixture(t, run) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-working-followup-'));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'feature/task']);
  await writeFile(join(repo, 'value.txt'), 'accepted\n');
  await git(repo, ['add', '.']);
  await git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'test: accepted work',
  ]);
  const store = new Store(join(directory, 'state'));
  store.setConfig({
    ...DEFAULT_CONFIG,
    repositories: [
      {
        id: 'repo',
        name: 'Example',
        path: repo,
        cwd: '.',
        strategy: 'attach',
        verificationMode: 'commands',
        checks: [],
        setup: [],
        instructions: '',
      },
    ],
  });
  const engine = new Engine(store, {
    harness: async ({ task, stage, harness }) => {
      if (stage === 'plan') assert.equal(harness, 'claude');
      return demoHandoff(task, stage);
    },
  });
  const task = engine.create({ title: 'Accepted work', repositoryId: 'repo' });
  Object.assign(task, {
    status: 'completed',
    workspace: repo,
    workspaceRoot: repo,
    branch: 'feature/task',
    baseCommit: await git(repo, ['rev-parse', 'HEAD']),
    setupCompleted: true,
  });
  store.save(task);
  const agent = new FollowUpAgent(store, engine, { configure() {} }, { run });
  t.after(async () => {
    await agent.stop();
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { agent, store, engine, task, repo };
}
function result(task, action = 'complete') {
  return {
    ...demoHandoff(task, 'investigate'),
    summary: 'Requested work finished',
    details: 'The requested PR metadata was updated and read back.',
    followUpAction: action,
  };
}
test('working follow-up uses selected provider and records a regular run', async (t) => {
  const f = await fixture(t, async (input) => {
    assert.equal(input.harness, 'pi');
    assert.equal(input.stage, 'followup');
    assert.equal(input.config.harnesses.pi.model, 'custom-model');
    assert.equal(input.config.harnesses.pi.effort, 'high');
    assert.equal(input.task.followUpRequest, 'Update the PR description');
    const prompt = buildPrompt(input.task, input.stage);
    assert.match(prompt, /perform the requested update now and read it back/);
    assert.match(prompt, /human approval before source edits/);
    input.onEvent({ type: 'activity', kind: 'message', summary: 'Reading the linked PR.' });
    input.onTerminal({ session: 'fixture' });
    return result(input.task);
  });
  await f.agent.start(f.task.id, {
    message: 'Update the PR description',
    provider: 'pi',
    model: 'custom-model',
    effort: 'high',
  });
  await f.agent.running.get(f.task.id).done;
  const task = f.store.get(f.task.id),
    run = task.deliveryRuns.at(-1);
  assert.equal(task.status, 'completed');
  assert.equal(task.sideQuestions?.length ?? 0, 0);
  assert.equal(run.status, 'complete');
  assert.equal(run.harness, 'pi');
  assert.deepEqual(run.settings, { model: 'custom-model', effort: 'high' });
  assert.equal(f.store.config.harnesses.pi.model, '');
  assert.equal(run.terminal.session, 'fixture');
  assert.equal(f.engine.workspaceReservations.size, 0);
});
test('source follow-up goes through selected-provider plan approval', async (t) => {
  const f = await fixture(t, async ({ task }) => result(task, 'changes'));
  await f.agent.start(f.task.id, {
    message: 'Add a regression test',
    provider: 'claude',
    model: 'custom-claude',
    effort: 'max',
  });
  await f.agent.running.get(f.task.id).done;
  for (let i = 0; i < 200 && f.store.get(f.task.id).status !== 'awaiting_plan'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const task = f.store.get(f.task.id);
  assert.equal(task.status, 'awaiting_plan');
  assert.equal(task.routing.plan, 'claude');
  assert.equal(task.routing.implement, 'claude');
  for (const stage of ['plan', 'implement']) {
    const config = executionConfig(task, f.store.config, stage);
    assert.equal(config.harnesses.claude.model, 'custom-claude');
    assert.equal(config.harnesses.claude.effort, 'max');
  }
  assert.equal(await readFile(join(f.repo, 'value.txt'), 'utf8'), 'accepted\n');
});
test('unapproved source mutation is preserved and blocks the follow-up', async (t) => {
  const f = await fixture(t, async ({ task }) => {
    await writeFile(join(task.workspace, 'value.txt'), 'unexpected edit\n');
    return result(task);
  });
  await f.agent.start(f.task.id, { message: 'Update PR metadata', provider: 'codex' });
  await f.agent.running.get(f.task.id).done;
  const task = f.store.get(f.task.id);
  assert.equal(task.deliveryRuns.at(-1).status, 'failed');
  assert.match(task.deliveryRuns.at(-1).error, /before approval/);
  assert.equal(await readFile(join(f.repo, 'value.txt'), 'utf8'), 'unexpected edit\n');
  assert.equal(task.status, 'completed');
  assert.equal(f.engine.workspaceReservations.size, 0);
});
test('working follow-up rejects unknown providers and concurrent writers, and cancels cleanly', async (t) => {
  const f = await fixture(
    t,
    ({ signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }),
      ),
  );
  await assert.rejects(
    f.agent.start(f.task.id, { message: 'Continue', provider: 'invented' }),
    /enabled agent/,
  );
  f.engine.workspaceReservations.set(f.repo, 'other');
  await assert.rejects(
    f.agent.start(f.task.id, { message: 'Continue', provider: 'codex' }),
    /owns this workspace/,
  );
  f.engine.workspaceReservations.clear();
  await f.agent.start(f.task.id, { message: 'Continue', provider: 'codex' });
  await assert.rejects(
    f.agent.start(f.task.id, { message: 'Again', provider: 'claude' }),
    /already starting or running/,
  );
  await f.agent.pause(f.task.id);
  assert.equal(f.store.get(f.task.id).deliveryRuns.at(-1).status, 'interrupted');
  assert.equal(f.engine.workspaceReservations.size, 0);
});

test('follow-up rejects invalid options before reserving or launching', async (t) => {
  const f = await fixture(t, () => {
    throw Error('must not launch');
  });
  for (const options of [
    { effort: 'ultra', provider: 'claude' },
    { model: { bad: true } },
    { model: 'line\nbreak' },
    { effort: 'unknown' },
  ]) {
    await assert.rejects(
      f.agent.start(f.task.id, { message: 'Explain this', provider: 'codex', ...options }),
    );
    assert.equal(f.agent.running.size, 0);
    assert.equal(f.engine.workspaceReservations.size, 0);
  }
});
