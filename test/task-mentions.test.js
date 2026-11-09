import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeMentions, mentionPresent, mentionQuestion } from '../public/task-mentions.js';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { WorkspaceAgent } from '../server/workspace-agent.js';
test('mentions respect word boundaries, repeated labels and escaping', () => {
  const m = { id: '12345678-1234-1234-1234-123456789abc', label: 'Fix empty results' };
  assert.equal(mentionPresent('Compare @Fix empty results and more', m.label), true);
  assert.equal(mentionPresent('mail@Fix empty results', m.label), false);
  assert.equal(mentionPresent('@Fix empty resultsExtra', m.label), false);
  assert.deepEqual(activeMentions('removed', [m]), []);
  assert.equal(
    (
      mentionQuestion('@Fix empty results and @Fix empty results', [m]).match(
        /class="task-mention"/g,
      ) || []
    ).length,
    2,
  );
  assert.match(mentionQuestion('<script> @Fix empty results', [m]), /&lt;script&gt;/);
  const malicious = { id: 'javascript:alert(1)', label: '<img>' };
  assert.doesNotMatch(mentionQuestion('@<img>', [malicious]), /<a|<img/);
});
test('mentioned task identities, fresh facts and revisions reach Relay without extra permissions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-mentions-')),
    store = new Store(directory),
    engine = new Engine(store);
  const agent = new WorkspaceAgent(store, engine);
  let prompt;
  t.after(async () => {
    await agent.stop();
    await engine.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.config.harnesses.claude = { enabled: true, command: process.execPath, model: 'test-model' };
  store.config.workspaceAgent.permissions.readSettings = false;
  agent.run = async (_cmd, _args, options) => {
    prompt = options.input;
    options.onLine(JSON.stringify({ type: 'result', result: 'Referenced task found.' }), 'stdout');
    return { code: 0, stderr: '' };
  };
  const task = engine.create({
    title: 'Fix results',
    description: 'Specific relevant behavior',
    demo: true,
  });
  const mention = { id: task.id, label: task.title };
  const record = await agent.ask('Check @Fix results', 'http://127.0.0.1', undefined, [mention]);
  await agent.done;
  assert.deepEqual(record.mentions, [mention]);
  assert.match(prompt, new RegExp(task.id));
  assert.match(prompt, /Specific relevant behavior/);
  assert.match(prompt, /MENTIONED TASKS/);
  assert.doesNotMatch(prompt, /"configuration":\{"concurrency"/);
  task.title = 'Renamed task';
  store.save(task);
  await agent.ask('Explain @Fix results', 'http://127.0.0.1', record.id);
  await agent.done;
  assert.match(prompt, /Renamed task/);
  store.deleteTask(task.id);
  await assert.rejects(
    agent.ask('Check @Fix results', 'http://127.0.0.1', undefined, [mention]),
    /deleted/,
  );
  await agent.ask('Removed the reference', 'http://127.0.0.1', record.id);
  await agent.done;
  assert.deepEqual(agent.history.at(-1).mentions, []);
  await assert.rejects(
    agent.ask('Bad', 'http://127.0.0.1', undefined, [null]),
    /Invalid task mention/,
  );
  await assert.rejects(
    agent.ask('Bad', 'http://127.0.0.1', undefined, Array(21).fill(mention)),
    /20 tasks/,
  );
});
