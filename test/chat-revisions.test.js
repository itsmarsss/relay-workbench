import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
test('chat revisions preserve prompts and replies and require valid authenticated originals', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-chat-revisions-'));
  let workspaceRuns = 0;
  const app = createApp({
    directory,
    publicDirectory: resolve('public'),
    engineOptions: {
      sideAnswer: async ({ question }) => `Reply to ${question}`,
      workspaceAgentRun: async (_command, _args, options) => {
        workspaceRuns++;
        options.onLine(
          JSON.stringify({ type: 'result', result: `Workspace reply ${workspaceRuns}` }),
          'stdout',
        );
        return { code: 0, stderr: '' };
      },
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  app.store.config.harnesses.claude.command = process.execPath;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await fetch(base + '/api/bootstrap').then((r) => r.json());
  const post = (path, data, authenticated = true) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { 'X-Relay-Token': token } : {}),
      },
      body: JSON.stringify(data),
    });
  async function complete(path) {
    for (let i = 0; i < 100; i++) {
      const value = await fetch(base + path).then((r) => r.json());
      const messages = Array.isArray(value) ? value : value.sideQuestions;
      if (messages.at(-1)?.status === 'complete') return messages;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Reply did not finish');
  }
  const original = await (
    await post('/api/workspace-agent', { question: 'Original workspace prompt' })
  ).json();
  await complete('/api/workspace-agent');
  assert.equal(
    (await post('/api/workspace-agent', { question: 'Revision', revisionOf: original.id }, false))
      .status,
    403,
  );
  assert.equal(
    (await post('/api/workspace-agent', { question: 'Revision', revisionOf: 'missing' })).status,
    404,
  );
  assert.equal(
    (
      await post('/api/workspace-agent', {
        question: 'Revised workspace prompt',
        revisionOf: original.id,
      })
    ).status,
    202,
  );
  const workspace = await complete('/api/workspace-agent');
  assert.equal(workspace.length, 2);
  assert.equal(workspace[0].question, 'Original workspace prompt');
  assert.equal(workspace[0].answer, 'Workspace reply 1');
  assert.equal(workspace[1].revisionOf, original.id);
  assert.equal(workspace[1].question, 'Revised workspace prompt');
  const task = app.engine.create({ title: 'Side chat', demo: true });
  const sideOriginal = await (
    await post(`/api/tasks/${task.id}/question`, { question: 'Original side prompt' })
  ).json();
  await complete(`/api/tasks/${task.id}`);
  assert.equal(
    (
      await post(`/api/tasks/${task.id}/question`, {
        question: 'Revision',
        revisionOf: original.id,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await post(`/api/tasks/${task.id}/question`, {
        question: 'Revised side prompt',
        revisionOf: sideOriginal.id,
      })
    ).status,
    202,
  );
  const side = await complete(`/api/tasks/${task.id}`);
  assert.equal(side.length, 2);
  assert.equal(side[0].question, 'Original side prompt');
  assert.equal(side[0].answer, 'Reply to Original side prompt');
  assert.equal(side[1].revisionOf, sideOriginal.id);
  assert.deepEqual(app.store.get(task.id).messages, []);
  assert.equal(app.store.get(task.id).status, 'draft');
});
