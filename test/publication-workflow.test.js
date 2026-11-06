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
async function fixture(t, publish, validate) {
  const root = await mkdtemp(join(tmpdir(), 'relay-publish-'));
  const state = await mkdtemp(join(tmpdir(), 'relay-publish-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
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
    directory: state,
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
    { publish, validate, memory: () => ({ entries: [], omitted: 0 }) },
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
    assert.equal(input.config.timeoutMinutes, 15);
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
  assert.equal(f.task.delivery.status, 'complete', f.task.delivery.details);
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
  await writeFile(join(root, 'value.txt'), 'external unapproved edit');
  await assert.rejects(f.workflow.start('task', 'repo'), /outside publication/);
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
  assert.match(html, /Retry publishing/);
  assert.match(html, /Details/);
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
  assert.equal(f.task.delivery.status, 'complete', f.task.delivery.details);
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
  assert.equal(f.task.delivery.status, 'interrupted');
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

const prepared = (baseCommit) => ({
  verdict: 'verification_requested',
  summary: 'Branch rebased and conflicts resolved',
  details: 'Preserved the accepted behavior',
  evidence: ['Inspected branch preparation'],
  risks: [],
  options: [],
  publication: { ...snapshot, url: '', state: 'unknown' },
  preparation: { baseCommit, scope: 'routine', summary: 'Routine branch update' },
});
async function upstream(f, t, conflict = false) {
  const other = `${f.root}-upstream`;
  await git(f.root, ['worktree', 'add', '-b', 'upstream', other, f.task.baseCommit]);
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, 'upstream.txt'), 'new upstream behavior');
  if (conflict) await writeFile(join(other, 'value.txt'), 'upstream value');
  await commit(other);
  return git(other, ['rev-parse', 'HEAD']);
}
async function verification(input, code = 0) {
  const { runCheck } = await import('../server/check-runner.js');
  const root = input.task.workspaceRoot;
  const args = [
    '-e',
    code
      ? 'process.exit(1)'
      : "if(require('fs').readFileSync('value.txt','utf8')!=='accepted')process.exit(2)",
  ];
  const spec = {
    repositoryId: 'repo',
    cwd: await (await import('node:fs/promises')).realpath(root),
    command: process.execPath,
    args,
  };
  await runCheck(input.task.verificationContext.runner, spec, input.signal);
  input.onEvent({ type: 'activity', kind: 'tool', summary: 'Ran supervised check' });
  return {
    verdict: 'complete',
    summary: 'Verified prepared branch',
    details: 'Executed affected regression check',
    evidence: ['Actual check exit recorded'],
    findings: [],
    verification: {
      checks: [{ ...spec, code, summary: 'Accepted behavior preserved' }],
      requirements: [
        {
          repositoryId: 'repo',
          source: 'Repository guidance',
          requirement: 'Preserve accepted behavior',
          checkIndices: [0],
        },
      ],
      reuse: [],
    },
  };
}

test('publication rebases then verifies and independently reviews before publishing', async (t) => {
  let root,
    base,
    publishCalls = 0;
  const seen = [];
  const f = await fixture(
    t,
    async (input) => {
      seen.push(input.task.publicationContext.phase);
      if (++publishCalls === 1) {
        input.onSession('publication-conversation');
        await commit(root);
        await assert.rejects(git(root, ['rebase', 'upstream']), /conflict/i);
        await writeFile(join(root, 'value.txt'), 'accepted');
        await git(root, ['add', 'value.txt']);
        await git(root, ['-c', 'core.editor=true', 'rebase', '--continue']);
        return prepared(base);
      }
      assert.equal(input.sessionId, 'publication-conversation');
      assert.equal(f.task.approvals.at(-1).type, 'publication_revalidation');
      return {
        verdict: 'complete',
        summary: 'Draft published',
        details: 'Remote head verified',
        evidence: ['Remote PR head matches prepared commit'],
        risks: [],
        options: [],
        publication: snapshot,
      };
    },
    async (input) => {
      seen.push(input.stage);
      assert.match(input.task.publicationContext.checkScope, /targeted fresh checks/);
      if (input.stage === 'verify') {
        assert.ok(Array.isArray(input.task.verificationContext.priorEvidence));
        const active = f.task.delivery;
        assert.equal(
          active.verificationRunner.attemptId,
          input.task.verificationContext.runner.attemptId,
        );
        assert.equal(active.verificationSignature, input.task.verificationContext.signature);
        return verification(input);
      }
      assert.equal(input.harness, f.task.routing.review);
      const baseline = JSON.parse(
        await (
          await import('node:fs/promises')
        ).readFile(input.task.publicationContext.approvalBaseline.acceptedSource, 'utf8'),
      );
      assert.match(baseline.patch, /accepted/);
      assert.equal(baseline.untracked[0].path, 'new.txt');
      return {
        verdict: 'complete',
        summary: 'Approved behavior preserved',
        details: 'Compared original and rebased diffs',
        evidence: ['Independent comparison to accepted source'],
        findings: [],
      };
    },
  );
  root = f.root;
  base = await upstream(f, t, true);
  f.task.routing.review = 'codex';
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.delivery.status, 'complete', f.task.delivery.details);
  assert.deepEqual(seen, ['publishing', 'verify', 'review', 'publishing']);
  assert.equal(f.task.baseCommit, base);
  assert.equal(f.task.deliveryRuns.length, 4);
  assert.deepEqual(
    f.task.deliveryRuns.map((r) => r.stage),
    ['publish', 'verify', 'review', 'publish'],
  );
  assert.equal(f.task.attempts.length, 0);
  assert.equal(f.task.status, 'completed');
  assert.equal(f.task.publication.url, snapshot.url);
  await git(root, ['rev-parse', f.task.delivery.approvalBaseline.ref]);
});

test('publication repairs failed checks and review findings without human handoff', async (t) => {
  let root,
    base,
    publishes = 0,
    checks = 0,
    reviews = 0;
  const f = await fixture(
    t,
    async (input) => {
      publishes++;
      if (publishes === 1) {
        await commit(root);
        await git(root, ['rebase', 'upstream']);
        return prepared(base);
      }
      if (input.task.publicationContext.phase === 'preparing') {
        assert.ok(input.task.publicationContext.repair);
        await writeFile(join(root, `repair-${publishes}.txt`), 'Routine approved repair');
        await commit(root);
        return prepared(base);
      }
      assert.equal(checks, 3);
      assert.equal(reviews, 2);
      return {
        verdict: 'complete',
        summary: 'Published repaired branch',
        details: 'Verified remote',
        evidence: ['Remote head matches'],
        risks: [],
        options: [],
        publication: snapshot,
      };
    },
    async (input) => {
      if (input.stage === 'verify') return verification(input, ++checks === 1 ? 1 : 0);
      return {
        verdict: ++reviews === 1 ? 'changes_requested' : 'complete',
        summary: reviews === 1 ? 'Add regression evidence' : 'Approved',
        details: 'Independent review',
        evidence: ['Compared accepted behavior'],
        findings:
          reviews === 1
            ? [{ severity: 'minor', file: 'value.txt', description: 'Add regression evidence' }]
            : [],
      };
    },
  );
  root = f.root;
  base = await upstream(f, t);
  f.task.routing.review = 'codex';
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.delivery.status, 'complete', f.task.delivery.details);
  assert.equal(publishes, 4);
  assert.equal(f.task.approvals.length, 1);
  assert.equal(f.reservations.size, 0);
  assert.equal(f.monitorCalls.at(-1)[2], true);
});

test('publication preserves actionable human blockers and never publishes design changes', async (t) => {
  const option = {
    id: 'compatibility',
    title: 'Choose compatibility policy',
    description: 'Two incompatible behaviors require a product decision',
    tradeoffs: 'Different caller guarantees',
  };
  const f = await fixture(
    t,
    async () => ({
      ...prepared(f.task.baseCommit),
      verdict: 'blocked',
      summary: 'A compatibility decision is needed',
      details: 'Conflicting caller contracts',
      risks: ['Choose the intended caller contract'],
      options: [option],
    }),
    async () => {
      throw Error('Must not publish or validate a blocked design');
    },
  );
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.delivery.status, 'blocked');
  assert.equal(f.task.delivery.summary, 'A compatibility decision is needed');
  assert.deepEqual(f.task.delivery.options, [option]);
  assert.equal(f.task.publication, undefined);
});

test('publication surfaces an explicit design change without validating or publishing it', async (t) => {
  const f = await fixture(
    t,
    async () => ({
      ...prepared(f.task.baseCommit),
      preparation: {
        baseCommit: f.task.baseCommit,
        scope: 'design_change',
        summary: 'Choose caller compatibility',
      },
      options: [
        {
          id: 'caller',
          title: 'Choose caller contract',
          description: 'Two contracts conflict',
          tradeoffs: 'Different client behavior',
        },
      ],
    }),
    async () => {
      throw Error('Design changes must not be auto accepted');
    },
  );
  await f.workflow.start('task', 'repo');
  await f.settle();
  assert.equal(f.task.delivery.status, 'blocked');
  assert.equal(f.task.delivery.options[0].id, 'caller');
  assert.equal(f.task.publication, undefined);
});
