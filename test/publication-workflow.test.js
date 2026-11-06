import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicationWorkflow, acceptedContent } from '../server/publication-workflow.js';
import { git, fingerprint } from '../server/workspace.js';
import { publicationPanel, publicationDetails } from '../public/publication.js';
import { runMemories, memoryRunHistory } from '../public/memory.js';
const snapshot = {
  url: 'https://code.example/team/project/pull/42',
  number: '42',
  title: 'Accepted change',
  state: 'open',
  draft: true,
  checks: 'pending',
  review: 'required',
};
const commit = async (root) => {
  await git(root, ['add', '--all']);
  await git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'feat: accepted change',
  ]);
};
async function fixture(t, publish) {
  const root = await mkdtemp(join(tmpdir(), 'relay-publish-'));
  await git(root, ['init', '-b', 'feature/change']);
  await writeFile(join(root, 'value.txt'), 'before');
  await commit(root);
  const baseCommit = await git(root, ['rev-parse', 'HEAD']);
  await writeFile(join(root, 'value.txt'), 'accepted');
  await writeFile(join(root, 'new.txt'), 'accepted new file');
  const task = {
    id: 'task',
    title: 'Accepted change',
    status: 'completed',
    stage: 'review',
    repository: { id: 'repo', name: 'Example', instructions: '' },
    routing: { implement: 'codex' },
    workspaceRoot: root,
    workspace: root,
    branch: 'feature/change',
    baseCommit,
    attempts: [],
    messages: [],
  };
  task.acceptedFingerprint = await fingerprint(task);
  const events = [],
    monitorCalls = [],
    reservations = new Map();
  const store = {
    directory: root,
    config: { harnesses: { codex: { enabled: true } } },
    all: () => [structuredClone(task)],
    get: () => structuredClone(task),
    save: (value, event) => {
      Object.assign(task, value);
      if (event) events.push(event);
    },
    event: (_, e) => events.push(e),
  };
  const monitor = { running: new Map(), configure: (...args) => monitorCalls.push(args) };
  const workflow = new PublicationWorkflow(
    store,
    { workspaceReservations: reservations },
    monitor,
    { publish },
  );
  t.after(async () => {
    await workflow.stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    task,
    workflow,
    events,
    monitorCalls,
    reservations,
    settle: async () => Promise.all([...workflow.running.values()].map((r) => r.done)),
  };
}
test('publication agent commits exactly accepted contents then hands off to monitoring', async (t) => {
  let root;
  const f = await fixture(t, async (input) => {
    assert.equal(input.stage, 'publish');
    assert.equal(input.task.publicationContext.expectedDraft, true);
    assert.equal(input.config.timeoutMinutes, 10);
    const before = await acceptedContent(input.task);
    await commit(root);
    assert.equal(await acceptedContent(input.task), before);
    input.onSession('publication-session');
    return {
      verdict: 'complete',
      summary: 'Draft PR published',
      details: 'Verified remote head',
      evidence: ['Remote PR matches committed HEAD'],
      risks: [],
      options: [],
      publication: snapshot,
    };
  });
  root = f.root;
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.delivery.status, 'complete');
  assert.equal(f.task.delivery.sessionId, 'publication-session');
  assert.equal(f.task.publication.url, snapshot.url);
  assert.equal(await git(root, ['status', '--porcelain']), '');
  assert.equal(f.task.status, 'completed');
  assert.deepEqual(
    f.monitorCalls.map((c) => c[2]),
    [false, true],
  );
  assert.equal(f.reservations.size, 0);
});
test('blocked publication retains its commit and retry receives failure context', async (t) => {
  let root,
    calls = 0;
  const f = await fixture(t, async (input) => {
    calls++;
    if (calls === 1) await commit(root);
    else assert.equal(input.task.publicationContext.previous.summary, 'Provider rejected the push');
    return {
      verdict: 'blocked',
      summary: 'Provider rejected the push',
      details: 'The provider requires branch preparation.',
      evidence: ['Read provider refusal'],
      risks: ['Prepare the branch and reverify before publishing.'],
      options: [],
      publication: { ...snapshot, url: '', state: 'unknown' },
    };
  });
  root = f.root;
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.delivery.status, 'blocked');
  assert.equal(f.task.delivery.commit, await git(root, ['rev-parse', 'HEAD']));
  assert.match(f.task.delivery.nextAction, /reverify/);
  assert.equal(
    f.monitorCalls.some((c) => c[2]),
    false,
  );
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(calls, 2);
});
test('publication rejects changed approval, duplicate writers and agent source edits', async (t) => {
  let root;
  const f = await fixture(t, async () => {
    await writeFile(join(root, 'value.txt'), 'unapproved');
    return {
      verdict: 'complete',
      summary: 'Unexpected',
      details: '',
      evidence: [],
      risks: [],
      options: [],
      publication: snapshot,
    };
  });
  root = f.root;
  f.task.status = 'awaiting_final';
  await assert.rejects(f.workflow.start('task', 'repo'), /Accept/);
  f.task.status = 'completed';
  f.reservations.set(root, 'another-task');
  await assert.rejects(f.workflow.start('task', 'repo'), /owns/);
  f.reservations.clear();
  await f.workflow.start('task', 'repo');
  await assert.rejects(f.workflow.start('task', 'repo'), /already running/);
  await f.settle();
  assert.equal(f.task.delivery.status, 'blocked');
  assert.equal(f.task.delivery.requiresReverification, true);
  assert.equal(f.task.publication, undefined);
  await assert.rejects(f.workflow.start('task', 'repo'), /reverify/);
});
test('compact memory summary opens exact snapshots without nested disclosures', () => {
  const task = {
    attempts: [
      {
        id: 'a',
        stage: 'review',
        harness: 'codex',
        startedAt: new Date().toISOString(),
        memorySnapshot: {
          entries: [
            {
              title: 'A preference',
              revision: 2,
              scope: 'task',
              kind: 'preference',
              content: 'Exact previous version',
            },
          ],
        },
      },
    ],
  };
  const compact = runMemories(task);
  assert.match(compact, /A preference/);
  assert.doesNotMatch(compact, /<details|Exact previous version/);
  const history = memoryRunHistory(task, 'a');
  assert.match(history, /Exact previous version/);
  assert.match(history, /v2/);
  const html = publicationPanel({
    ...task,
    status: 'completed',
    repository: { id: 'repo', name: 'Example' },
    submission: { status: 'failed', stderr: 'VERY LONG RAW LOG' },
  });
  assert.match(html, /Retry publication with agent/);
  assert.match(html, /View technical details/);
  assert.doesNotMatch(html, /VERY LONG RAW LOG/);
  assert.match(
    publicationDetails(
      {
        ...task,
        repository: { id: 'repo', name: 'Example' },
        submission: { stderr: 'VERY LONG RAW LOG' },
      },
      'repo',
    ),
    /VERY LONG RAW LOG/,
  );
});

test('publication resumes an interrupted accepted commit safely', async (t) => {
  const f = await fixture(t, async (input) => {
    assert.equal(input.task.publicationContext.previous.status, 'interrupted');
    return {
      verdict: 'complete',
      summary: 'Existing draft verified',
      details: '',
      evidence: ['Remote head verified'],
      risks: [],
      options: [],
      publication: snapshot,
    };
  });
  const originalHead = await git(f.root, ['rev-parse', 'HEAD']);
  const content = await acceptedContent(f.task);
  await commit(f.root);
  f.task.delivery = { status: 'interrupted', originalHead, content };
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.delivery.status, 'complete');
  assert.equal(f.reservations.size, 0);
});

test('pausing publication preserves accepted work and releases its writer', async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, async ({ signal }) => {
    started();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Publication cancelled');
  });
  const content = await acceptedContent(f.task);
  await f.workflow.start('task', 'repo');
  await ready;
  f.workflow.pause('task');
  await f.settle();
  assert.equal(f.task.delivery.status, 'blocked');
  assert.equal(f.task.delivery.stopRequested, true);
  assert.equal(f.task.delivery.requiresReverification, false);
  assert.equal(await acceptedContent(f.task), content);
  assert.equal(f.reservations.size, 0);
  assert.deepEqual(
    f.monitorCalls.map((c) => c[2]),
    [false],
  );
});

test('delivery history snapshots survive retry without altering development attempts', async (t) => {
  const f = await fixture(t, async () => ({
    verdict: 'blocked',
    summary: 'Provider needs preparation',
    details: 'Read policy',
    evidence: ['Provider refusal'],
    risks: ['Reverify'],
    options: [],
    publication: { ...snapshot, url: '', state: 'unknown' },
  }));
  await f.workflow.start('task', 'repo');
  await f.settle();
  const first = structuredClone(f.task.deliveryRuns[0]);
  assert.notEqual(first.parentAttemptId, first.id);
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.deliveryRuns.length, 2);
  assert.deepEqual(f.task.deliveryRuns[0], first);
  assert.equal(f.task.deliveryRuns[1].parentAttemptId, first.id);
  assert.equal(f.task.deliveryRuns[1].handoff.summary, 'Provider needs preparation');
  assert.equal(f.task.attempts.length, 0);
  assert.equal(f.events.at(-1).attemptId, f.task.delivery.id);
});

test('older delivery runs recover from events with uncertain outcomes labeled', async () => {
  const { recoverDeliveryRuns } = await import('../server/delivery-runs.js');
  const task = {
    attempts: [],
    repository: { id: 'repo' },
    delivery: {
      id: 'latest',
      startedAt: '2026-01-02T00:00:00Z',
      status: 'blocked',
      harness: 'codex',
      summary: 'Needs preparation',
    },
  };
  const events = [
    { attemptId: 'old', stage: 'publish', at: '2026-01-01T00:00:00Z', harness: 'codex' },
  ];
  assert.equal(recoverDeliveryRuns(task, events, [task]), true);
  assert.equal(task.deliveryRuns.length, 2);
  assert.equal(task.deliveryRuns[0].status, 'recorded');
  assert.match(task.deliveryRuns[0].handoff.summary, /outcome was not retained/);
  assert.equal(task.deliveryRuns[1].status, 'blocked');
  assert.equal(recoverDeliveryRuns(task, events, [task]), false);
});
