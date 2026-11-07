import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { newTask, DEFAULT_CONFIG } from '../server/domain.js';
import { SideQuestions, questionContext } from '../server/side-questions.js';
import { elapsed, timer, liveProgress, updateTimers } from '../public/live-progress.js';
import { sideChat } from '../public/side-chat.js';
test('side questions use a snapshot and never steer or overwrite the worker', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-side-'));
  const store = new Store(directory);
  let release;
  const pending = new Promise((r) => (release = r));
  const side = new SideQuestions(store, {
    answer: async ({ context, question }) => {
      assert.equal(context.stage, 'implement');
      assert.equal(question, 'Why?');
      await pending;
      return 'Recorded evidence';
    },
  });
  t.after(async () => {
    await side.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = newTask({ title: 'Side context', demo: true }, DEFAULT_CONFIG);
  task.status = 'running';
  task.stage = 'implement';
  task.messages = [];
  store.save(task);
  side.ask(task.id, 'Why?');
  assert.throws(() => side.ask(task.id, 'Again'), /already running/);
  const current = store.get(task.id);
  current.stage = 'verify';
  current.messages.push({ text: 'Worker feedback' });
  store.save(current);
  release();
  await side.running.get(task.id).done;
  const result = store.get(task.id);
  assert.equal(result.status, 'running');
  assert.equal(result.stage, 'verify');
  assert.equal(result.messages.length, 1);
  assert.equal(result.sideQuestions[0].answer, 'Recorded evidence');
  assert.equal(result.sideQuestions[0].stage, 'implement');
});
test('live elapsed timers advance without rerendering and stop when finished', () => {
  assert.equal(elapsed(65000), '01:05');
  assert.equal(elapsed(3661000), '1:01:01');
  assert.equal(elapsed(-1), '00:00');
  const start = '2026-01-01T00:00:00Z';
  assert.match(timer(start, null, Date.parse(start) + 1000), /00:01/);
  assert.doesNotMatch(timer(start, start), /data-live-start/);
  const node = { dataset: { liveStart: start } };
  updateTimers({ querySelectorAll: () => [node] }, Date.parse(start) + 2000);
  assert.equal(node.textContent, '00:02');
  assert.match(
    liveProgress({
      status: 'running',
      attempts: [{ status: 'running', startedAt: start, stage: 'implement', harness: 'codex' }],
    }),
    /Live task progress/,
  );
  assert.equal(liveProgress({ status: 'blocked', attempts: [] }), '');
});
test('side chat escapes questions and sanitizes answers', () => {
  const html = sideChat(
    {
      sideQuestions: [
        {
          question: '<script>bad</script>',
          createdAt: new Date().toISOString(),
          stage: 'implement',
          status: 'complete',
          answer: '<script>bad</script>',
        },
      ],
    },
    true,
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /cannot steer/);
});

test('side context includes publication results without routine polls hiding useful activity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-side-context-'));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = newTask({ title: 'Published task', demo: true }, DEFAULT_CONFIG);
  task.publication = { url: 'https://code.example/pr/1', state: 'open' };
  task.delivery = { status: 'running', stage: 'verify', summary: 'Checking prepared source' };
  task.deliveryRuns = [
    { stage: 'publish', status: 'complete', handoff: { summary: 'Prepared' } },
    { stage: 'monitor', status: 'complete' },
  ];
  store.save(task);
  store.event(task.id, { type: 'feedback', summary: 'Useful direction' });
  for (let i = 0; i < 40; i++)
    store.event(task.id, { type: 'activity', stage: 'monitor', summary: 'Polling' });
  store.event(task.id, {
    type: 'publication',
    stage: 'monitor',
    observationChange: true,
    summary: 'Checks passing',
  });
  const context = questionContext(store, store.get(task.id));
  assert.equal(context.repositories[0].publication.state, 'open');
  assert.equal(context.repositories[0].publishing.stage, 'verify');
  assert.equal(context.publicationRuns.length, 1);
  assert.ok(context.recentActivity.some((e) => e.summary === 'Useful direction'));
  assert.ok(context.recentActivity.some((e) => e.summary === 'Checks passing'));
  assert.ok(!context.recentActivity.some((e) => e.summary === 'Polling'));
});
