import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  acceptResult,
  approvePlan,
  createTask,
  fetchBootstrap,
  fetchTasks,
  saveConfig,
  taskAction,
  resolveBlocker,
} from './api.ts';
const token = 'a'.repeat(64),
  revision = 'b'.repeat(64);
test('bootstrap and draft creation validate responses and send session token', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify(
        String(input) === '/api/bootstrap'
          ? { token, configRevision: revision, config: { repositories: [] } }
          : { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Test', status: 'draft' },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    const boot = await fetchBootstrap();
    assert.equal(boot.token, token);
    const task = await createTask(boot.token, { title: 'Test', demo: true });
    assert.equal(task.status, 'draft');
    assert.equal((calls[1]!.init!.headers as Record<string, string>)['X-Relay-Token'], token);
    assert.equal(calls[1]!.init!.method, 'POST');
  } finally {
    globalThis.fetch = original;
  }
});
test('workflow actions use the local session token and surface failures', async () => {
  const original = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(
      JSON.stringify({
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Task',
        status: 'queued',
      }),
      { status: 202 },
    );
  };
  try {
    const result = await taskAction(token, '550e8400-e29b-41d4-a716-446655440000', 'start');
    assert.equal(result.status, 'queued');
    assert.match(request!.url, /\/start$/);
    assert.equal((request!.init!.headers as Record<string, string>)['X-Relay-Token'], token);
    assert.equal(request!.init!.body, '{}');
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'Workspace is busy' }), { status: 409 });
    await assert.rejects(taskAction(token, result.id, 'resume'), /Workspace is busy/);
  } finally {
    globalThis.fetch = original;
  }
});
test('approval and acceptance send explicit authenticated decisions', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Task',
        status: 'queued',
      }),
      { status: 200 },
    );
  };
  try {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    await approvePlan(token, id, 'option-a', 'Please proceed', 'plan-id', revision);
    await acceptResult(token, id, revision);
    assert.match(calls[0]!.url, /\/approve-plan$/);
    assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)), {
      optionId: 'option-a',
      note: 'Please proceed',
      planAttemptId: 'plan-id',
      taskRevision: revision,
    });
    assert.match(calls[1]!.url, /\/accept$/);
    assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), { taskRevision: revision });
    assert.equal((calls[1]!.init!.headers as Record<string, string>)['X-Relay-Token'], token);
  } finally {
    globalThis.fetch = original;
  }
});
test('blocker decisions include the inspected revision and no automation authority', async () => {
  const original = globalThis.fetch;
  let sent: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    sent = init;
    return new Response(
      JSON.stringify({
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Task',
        status: 'queued',
      }),
      { status: 202 },
    );
  };
  try {
    await resolveBlocker(
      token,
      '550e8400-e29b-41d4-a716-446655440000',
      revision,
      'decision',
      'retry',
      'choice',
      'Try again',
    );
    assert.deepEqual(JSON.parse(String(sent!.body)), {
      taskRevision: revision,
      decisionId: 'decision',
      resolution: 'retry',
      optionId: 'choice',
      note: 'Try again',
    });
  } finally {
    globalThis.fetch = original;
  }
});
test('configuration saves carry the inspected revision and surface conflicts', async () => {
  const original = globalThis.fetch;
  let sent: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    sent = init;
    return new Response(JSON.stringify({ error: 'Configuration changed; refresh before saving' }), {
      status: 409,
    });
  };
  try {
    await assert.rejects(
      saveConfig(token, revision, { repositories: [] }),
      (error) => error instanceof ApiError && error.status === 409,
    );
    assert.equal((sent!.headers as Record<string, string>)['If-Match'], revision);
  } finally {
    globalThis.fetch = original;
  }
});
test('malformed task or bootstrap responses fail rather than inventing state', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ id: 'bad', title: 'x', status: 'draft' }]), { status: 200 });
  try {
    await assert.rejects(fetchTasks(), /invalid/);
    await assert.rejects(fetchBootstrap(), /invalid/);
  } finally {
    globalThis.fetch = original;
  }
});
