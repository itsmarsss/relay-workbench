import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyLoopGuard } from '../server/loop-guard.js';
import { feedbackItems, FeedbackAutopilot } from '../server/feedback-autopilot.js';
import { requirePublicationPrerequisites } from '../server/publication-prerequisites.js';
import {
  workflowHealth,
  decisionBrief,
  completionBrief,
  repositoryCoordination,
} from '../public/workflow-insights.js';
import { DEFAULT_CONFIG, newTask, reconfigureTask, handoffSchema } from '../server/domain.js';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { createApp } from '../server/app.js';
const failure = (id, changes = {}) => ({
  id,
  stage: 'implement',
  status: 'complete',
  fingerprint: 'source-a',
  handoff: {
    verdict: 'blocked',
    summary: 'Same reproducible error',
    evidence: ['command exited 1'],
  },
  ...changes,
});
test('loop guard changes strategy before stopping identical failures on unchanged source', () => {
  const task = { attempts: [], status: 'queued', recovery: { active: true } };
  task.attempts.push(failure('one'));
  assert.equal(applyLoopGuard(task, task.attempts.at(-1)), false);
  task.attempts.push(failure('two'));
  assert.equal(applyLoopGuard(task, task.attempts.at(-1)), true);
  assert.equal(task.status, 'queued');
  assert.equal(task.loopGuard.stopped, false);
  task.attempts.push(failure('three'));
  applyLoopGuard(task, task.attempts.at(-1));
  assert.equal(task.status, 'blocked');
  assert.equal(task.recovery.active, false);
  assert.equal(task.blockerDecision.kind, 'loop_guard');
  assert.equal(workflowHealth(task).repeated, 3);
  task.loopGuardAcknowledgedAt = task.attempts.length;
  task.attempts.push(failure('four'));
  assert.equal(applyLoopGuard(task, task.attempts.at(-1)), false);
});
test('progress, different repositories and timeouts never become repeated failure loops', () => {
  for (const changes of [
    { fingerprint: 'source-b' },
    {
      handoff: {
        verdict: 'blocked',
        summary: 'Same reproducible error',
        evidence: ['New diagnostic finding'],
      },
    },
    { repositoryId: 'other' },
    { handoff: { verdict: 'complete', summary: 'Same reproducible error' } },
    { handoff: undefined, status: 'interrupted', error: 'Time budget exceeded' },
  ]) {
    const task = {
      attempts: [failure('one'), failure('two'), failure('three', changes)],
      status: 'queued',
    };
    assert.equal(applyLoopGuard(task, task.attempts.at(-1)), false);
    assert.equal(task.status, 'queued');
  }
});
const item = {
  id: 'review-1',
  kind: 'repair',
  summary: 'Handle an empty result',
  details: 'A regression test is missing.',
  url: 'https://code.example/pull/1#review-1',
};
function feedbackFixture() {
  let task = {
    id: 'task',
    status: 'completed',
    repository: { id: 'repo', name: 'Example' },
    publication: { state: 'open', url: 'https://code.example/pull/1' },
    attempts: [],
  };
  const calls = [],
    events = [];
  const store = {
    get: () => structuredClone(task),
    save: (value, event) => {
      task = structuredClone(value);
      if (event) events.push(event);
    },
  };
  const engine = {
    action: async (...args) => {
      calls.push(args);
      task.status = 'queued';
    },
  };
  const publisher = { start: async (...args) => calls.push(['publish', ...args]) };
  const agent = new FeedbackAutopilot(store, engine, publisher);
  return { store, agent, calls, events, engine, publisher };
}
test('feedback is validated, deduplicated durably, planned and published only after acceptance', async () => {
  assert.throws(() => feedbackItems([{ ...item, url: 'javascript:alert(1)' }]), /URL/);
  assert.throws(() => feedbackItems([{ ...item, kind: 'merge' }]), /classification/);
  assert.equal(feedbackItems([item])[0].signature, feedbackItems([item])[0].signature);
  const f = feedbackFixture();
  await f.agent.observe('task', 'repo', [item]);
  assert.equal(f.calls.length, 0);
  f.agent.configure('task', 'repo', true);
  await f.agent.observe('task', 'repo', [item]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], 'follow-up');
  assert.match(f.calls[0][2].message, /Do not publish/);
  const task = f.store.get();
  task.status = 'completed';
  f.store.save(task);
  const restored = new FeedbackAutopilot(f.store, f.engine, f.publisher);
  await restored.observe('task', 'repo', [item]);
  assert.equal(f.calls.length, 1);
  await restored.afterAccept('task');
  assert.deepEqual(f.calls[1], ['publish', 'task', 'repo']);
});
test('questions and design choices need direction and dismissal cannot start an agent', async () => {
  const f = feedbackFixture();
  f.agent.configure('task', 'repo', true);
  await f.agent.observe('task', 'repo', [{ ...item, kind: 'decision' }]);
  assert.equal(f.calls.length, 0);
  const record = f.store.get().feedbackAutopilot.current;
  assert.equal(record.state, 'needs_decision');
  assert.throws(() => f.agent.dismiss('task', 'repo', 'stale'), /changed/);
  f.agent.dismiss('task', 'repo', record.id);
  await f.agent.observe('task', 'repo', [{ ...item, kind: 'decision' }]);
  assert.equal(f.calls.length, 0);
  await f.agent.observe('task', 'repo', [{ ...item, details: 'Revised comment' }]);
  assert.equal(f.calls.length, 1);
});
test('feedback repair cycles are bounded and startup failures are explained', async () => {
  const f = feedbackFixture();
  f.agent.configure('task', 'repo', true);
  const task = f.store.get();
  task.feedbackAutopilot.history = [1, 2, 3].map((n) => ({
    id: String(n),
    signatures: [],
    state: 'complete',
  }));
  f.store.save(task);
  await f.agent.observe('task', 'repo', [item]);
  assert.equal(f.calls.length, 0);
  assert.match(f.store.get().feedbackAutopilot.current.reason, /Three/);
  const g = feedbackFixture();
  g.agent.configure('task', 'repo', true);
  g.engine.action = async () => {
    throw Error('Workspace busy');
  };
  await g.agent.observe('task', 'repo', [item]);
  assert.equal(g.store.get().feedbackAutopilot.current.state, 'needs_decision');
  assert.match(g.store.get().feedbackAutopilot.current.reason, /Workspace busy/);
});
test('repository prerequisites permit draft publication but expose manual landing order', () => {
  const task = {
    repositories: [
      { repository: { id: 'api', name: 'API' } },
      { repository: { id: 'web', name: 'Web' } },
    ],
    dependencies: [{ repositoryId: 'web', dependsOn: 'api' }],
    attempts: [],
  };
  assert.throws(() => requirePublicationPrerequisites(task, 'web'), /API/);
  requirePublicationPrerequisites(task, 'api');
  task.repositories[0].publication = { state: 'open', url: 'https://code.example/pull/1' };
  requirePublicationPrerequisites(task, 'web');
  assert.deepEqual(repositoryCoordination(task)[1].waiting, ['API']);
  task.repositories[0].publication.state = 'merged';
  assert.deepEqual(repositoryCoordination(task)[1].waiting, []);
  assert.throws(
    () => requirePublicationPrerequisites({ ...task, preset: 'investigate' }, 'api'),
    /cannot publish/,
  );
});
test('preset validation, decision recommendation and completion evidence remain explicit', () => {
  const task = newTask({ title: 'Investigate', demo: true, preset: 'investigate' }, DEFAULT_CONFIG);
  assert.match(task.workflowGuidance, /Do not modify/);
  assert.throws(
    () => newTask({ title: 'Bad', demo: true, preset: 'skip-checks' }, DEFAULT_CONFIG),
    /preset/,
  );
  task.status = 'paused';
  assert.throws(
    () => reconfigureTask(task, { expectedRevision: 0, preset: null }, DEFAULT_CONFIG),
    /fixed/,
  );
  task.status = 'awaiting_plan';
  task.attempts = [
    {
      stage: 'plan',
      handoff: {
        summary: 'Choose a repair',
        options: [{ id: 'a', title: 'Focused fix' }],
        evidence: ['reproduction'],
      },
    },
  ];
  assert.equal(decisionBrief(task).recommendation, 'Focused fix');
  task.verifiedFingerprint = 'a';
  task.reviewedFingerprint = 'a';
  task.approvals = [{ type: 'approach' }];
  task.attempts.push({
    stage: 'verify',
    handoff: { checks: [{ name: 'focused check', code: 0 }], risks: ['One compatibility risk'] },
  });
  const brief = completionBrief(task);
  assert.equal(brief.checks.length, 1);
  assert.equal(brief.verified, true);
  assert.deepEqual(brief.risks, ['One compatibility risk']);
  assert.ok(handoffSchema('monitor').properties.feedback);
});
async function wait(store, id, status) {
  for (let i = 0; i < 1000; i++) {
    const task = store.get(id);
    if (task.status === status) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`Did not reach ${status}`);
}
test('investigation preset finishes read-only and small changes retain both approval gates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-productivity-'));
  const store = new Store(dir);
  const engine = new Engine(store, { demoDelay: 1 });
  t.after(async () => {
    await engine.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const investigation = engine.create({
    title: 'Read-only findings',
    demo: true,
    preset: 'investigate',
  });
  await engine.action(investigation.id, 'start');
  const done = await wait(store, investigation.id, 'completed');
  assert.ok(done.attempts.every((a) => ['triage', 'investigate'].includes(a.stage)));
  assert.equal(done.approvals.length, 0);
  await assert.rejects(engine.action(done.id, 'follow-up', { message: 'Edit code' }), /Duplicate/);
  const small = engine.create({ title: 'Small change', demo: true, preset: 'small' });
  await engine.action(small.id, 'start');
  const planned = await wait(store, small.id, 'awaiting_plan');
  assert.ok(planned.attempts.every((a) => a.stage !== 'triage'));
  await engine.action(small.id, 'approve-plan', {
    optionId: planned.attempts.at(-1).handoff.options[0].id,
  });
  await wait(store, small.id, 'awaiting_final');
  assert.equal(store.get(small.id).approvals.length, 1);
  await engine.action(small.id, 'accept');
  assert.equal(store.get(small.id).status, 'completed');
});
test('inbox decisions require human authentication and reject a superseded proposal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-inbox-decide-'));
  const app = createApp({
    directory: dir,
    publicDirectory: resolve('public'),
    engineOptions: { demoDelay: 1 },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await (await fetch(base + '/api/bootstrap')).json();
  const task = app.engine.create({ title: 'Decision', demo: true });
  await app.engine.action(task.id, 'start');
  await wait(app.store, task.id, 'awaiting_plan');
  const [item] = await (await fetch(base + '/api/inbox')).json();
  const payload = {
    key: item.key,
    taskId: task.id,
    operation: 'approve-plan',
    optionId: item.brief.options[0].id,
  };
  const post = (body, auth = true) =>
    fetch(base + '/api/inbox/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-relay-token': token } : {}) },
      body: JSON.stringify(body),
    });
  assert.equal((await post(payload, false)).status, 403);
  assert.equal((await post({ ...payload, key: 'stale' })).status, 409);
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload)).status, 409);
});
