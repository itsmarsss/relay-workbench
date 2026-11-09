import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { WorkspaceAgent } from '../server/workspace-agent.js';
import { createApp } from '../server/app.js';
import {
  proposeTaskChanges,
  decideTaskProposal,
  latestTaskConfirmation,
} from '../server/task-proposals.js';
import { proposeConfiguration } from '../server/workspace-permissions.js';
import { FeedbackAutopilot } from '../server/feedback-autopilot.js';
import { feedbackWorkflowStage } from '../public/publication.js';
import { completionBrief } from '../public/workflow-insights.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-feature-audit-'));
  const store = new Store(directory),
    engine = new Engine(store);
  engine.tick = () => {};
  t.after(async () => {
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, engine };
}
test('plain yes is ambiguous when settings proposals also await approval', async (t) => {
  const { store, engine } = await fixture(t),
    task = engine.create({ title: 'Draft', demo: true });
  proposeTaskChanges(
    store,
    [{ taskId: task.id, operation: 'settings', settings: { preset: 'small' } }],
    'Focus scope',
    'latest',
  );
  assert.ok(latestTaskConfirmation(store, [{ id: 'latest', status: 'complete' }], 'yes'));
  proposeConfiguration(store, [{ path: ['concurrency'], value: 3 }], 'Independent work', 'latest');
  assert.equal(latestTaskConfirmation(store, [{ id: 'latest', status: 'complete' }], 'yes'), null);
});
test('submission changes reject an entire mixed proposal before any mutation', async (t) => {
  const { store, engine } = await fixture(t),
    draft = engine.create({ title: 'Draft', demo: true }),
    published = engine.create({ title: 'Published', demo: true });
  published.demo = false;
  published.status = 'completed';
  published.publication = { state: 'open', url: 'https://code.example/pull/1' };
  store.save(published);
  const proposal = proposeTaskChanges(
    store,
    [
      { taskId: draft.id, operation: 'settings', settings: { preset: 'small' } },
      {
        taskId: published.id,
        operation: 'feedback',
        repositoryId: published.repository.id,
        enabled: true,
      },
    ],
    'Configure work',
  );
  published.submission = { status: 'running' };
  store.save(published);
  await assert.rejects(
    decideTaskProposal(store, engine, { jobs: new Map() }, {}, proposal.id, 'approve'),
    /publication/,
  );
  assert.notEqual(store.get(draft.id).preset, 'small');
  assert.equal(store.get(published.id).feedbackAutopilot, undefined);
});
test('human feedback direction reconnects the repair and publishing workflow', async (t) => {
  const { store, engine } = await fixture(t),
    task = engine.create({ title: 'Feedback repair', demo: true });
  task.status = 'completed';
  task.publication = { state: 'open' };
  task.feedbackAutopilot = {
    enabled: true,
    current: { id: 'feedback', state: 'needs_decision', runId: 'observer' },
    history: [{ id: 'feedback', state: 'needs_decision', signatures: [] }],
  };
  store.save(task);
  await assert.rejects(
    engine.action(task.id, 'follow-up', { feedbackId: 'stale', message: 'Choose option A' }),
    /Feedback changed/,
  );
  await engine.action(task.id, 'follow-up', { feedbackId: 'feedback', message: 'Choose option A' });
  const queued = store.get(task.id);
  assert.equal(queued.feedbackAutopilot.current.state, 'proposed');
  assert.equal(queued.feedbackAutopilot.current.followUpId, queued.followUpContext.id);
  assert.equal(queued.followUpContext.sourceFeedbackId, 'observer');
  queued.status = 'completed';
  store.save(queued);
  const calls = [];
  const feedback = new FeedbackAutopilot(store, engine, {
    start: async (...args) => calls.push(args),
  });
  await feedback.afterAccept(task.id);
  assert.equal(calls.length, 1);
});
test('accepted unrelated follow-ups never publish another feedback cycle', async (t) => {
  const { store, engine } = await fixture(t),
    task = engine.create({ title: 'Unrelated change', demo: true });
  task.status = 'completed';
  task.followUpContext = { id: 'unrelated' };
  task.feedbackAutopilot = {
    enabled: true,
    current: { id: 'feedback', state: 'proposed', followUpId: 'older' },
    history: [],
  };
  store.save(task);
  const calls = [];
  await new FeedbackAutopilot(store, engine, { start: async () => calls.push(true) }).afterAccept(
    task.id,
  );
  assert.equal(calls.length, 0);
});
test('result notes retain implementation risks and feedback stops watching closed PRs', () => {
  const task = {
    status: 'completed',
    repository: { id: 'repo' },
    publication: { state: 'merged' },
    feedbackAutopilot: { enabled: true },
    attempts: [
      {
        id: 'implementation',
        stage: 'implement',
        handoff: { verdict: 'complete', summary: 'Fixed', risks: ['Rollout requirement'] },
      },
    ],
  };
  assert.deepEqual(completionBrief(task).risks, ['Rollout requirement']);
  assert.match(feedbackWorkflowStage(task), /PR merged/);
  assert.doesNotMatch(feedbackWorkflowStage(task), /Watching PR/);
});
test('yes produces a durable Relay receipt without needing an AI provider', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-approval-receipt-'));
  const seed = new Store(directory);
  seed.setConfig({
    ...seed.config,
    harnesses: {
      ...seed.config.harnesses,
      claude: { ...seed.config.harnesses.claude, enabled: false },
    },
  });
  seed.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(
    'workspace-agent',
    JSON.stringify([
      {
        id: 'latest',
        status: 'complete',
        question: 'Configure drafts',
        answer: 'Approve this request.',
      },
    ]),
  );
  seed.close();
  const app = createApp({ directory, publicDirectory: resolve('public') });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = (await fetch(base + '/api/bootstrap').then((r) => r.json())).token;
  const task = app.engine.create({ title: 'Draft', demo: true });
  proposeTaskChanges(
    app.store,
    [{ taskId: task.id, operation: 'settings', settings: { preset: 'small' } }],
    'Focus scope',
    'latest',
  );
  const send = (data) =>
    fetch(base + '/api/workspace-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token },
      body: JSON.stringify(data),
    });
  assert.equal((await send({ question: ' '.repeat(10001) + 'yes' })).status, 400);
  assert.notEqual(app.store.get(task.id).preset, 'small');
  await send({ question: 'yes', revisionOf: 'latest' });
  assert.notEqual(app.store.get(task.id).preset, 'small');
  const response = await send({ question: 'yes' });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.provider, 'relay');
  assert.equal(receipt.status, 'complete');
  assert.equal(app.store.get(task.id).preset, 'small');
  const history = await fetch(base + '/api/workspace-agent').then((r) => r.json());
  assert.equal(history.at(-1).id, receipt.id);
});
