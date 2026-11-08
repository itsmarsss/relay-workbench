// Supervised inside Relay's existing process group and tmux pane.
import { spawn } from 'node:child_process';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let sequence = 0,
  threadId,
  turnId,
  finishing = false,
  polling = false,
  done = false;
const pending = new Map();
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    send(spec.harness === 'codex' ? { id, method, params } : { id, type: method, ...params });
  });
}
function fail(error) {
  if (done) return;
  emit({ type: 'relay.error', error: error.message });
  finish(1);
}
function finish(code) {
  if (done) return;
  done = true;
  clearInterval(poll);
  for (const call of pending.values()) call.reject(new Error('Native session closed'));
  pending.clear();
  child.stdin.end();
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
  kill.unref();
  child.once('close', () => {
    clearTimeout(kill);
    process.exit(code);
  });
}
async function drain() {
  if (polling || done) return;
  polling = true;
  try {
    for (const name of (await readdir(spec.controlDirectory))
      .filter((n) => /^[a-f0-9-]+\.json$/.test(n))
      .sort()) {
      const path = join(spec.controlDirectory, name);
      const command = JSON.parse(await readFile(path, 'utf8'));
      try {
        if (finishing) throw new Error('Turn already completed; direction remains pending');
        if (spec.harness === 'codex')
          await request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: 'text', text: command.message }],
          });
        else await request('steer', { message: command.message });
        emit({ type: 'relay.delivery', id: command.id, delivery: 'accepted' });
      } catch (error) {
        emit({ type: 'relay.delivery', id: command.id, delivery: 'pending', error: error.message });
      }
      await unlink(path);
    }
  } finally {
    polling = false;
  }
}
async function completed(error) {
  if (done || finishing) return;
  finishing = true;
  if (error) return fail(new Error(error));
  // Drain any commands racing the final event; they are explicitly left pending.
  while (polling) await new Promise((r) => setTimeout(r, 10));
  await drain();
  finish(0);
}
createInterface({ input: child.stdout }).on('line', (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return emit({ type: 'relay.activity', summary: line });
  }
  const call = pending.get(event.id);
  if (
    call &&
    (spec.harness === 'codex' ? 'result' in event || 'error' in event : event.type === 'response')
  ) {
    pending.delete(event.id);
    if (event.error || event.success === false)
      call.reject(new Error(event.error?.message || event.error || 'Native request rejected'));
    else call.resolve(event.result ?? event.data);
    return;
  }
  // Unexpected tool/permission requests are refused; no new permissions are granted here.
  if (spec.harness === 'codex' && event.method && event.id !== undefined) {
    send({
      id: event.id,
      error: { code: -32601, message: 'Relay cannot approve interactive requests' },
    });
    return;
  }
  if (spec.harness === 'pi') {
    emit(event);
    if (event.type === 'agent_end') completed().catch(fail);
    return;
  }
  const { method, params = {} } = event;
  if (method === 'turn/started') turnId = params.turn.id;
  if (['item/started', 'item/completed'].includes(method) && params.item) {
    const item = params.item,
      completed = method === 'item/completed';
    if (item.type === 'agentMessage') {
      if (completed)
        emit({ type: 'item.completed', item: { type: 'agent_message', text: item.text } });
    } else if (item.type === 'commandExecution')
      emit({
        type: completed ? 'item.completed' : 'item.started',
        item: {
          type: 'command_execution',
          command: item.command,
          aggregated_output: item.aggregatedOutput,
          exit_code: item.exitCode,
        },
      });
    else if (item.type === 'fileChange' && completed)
      emit({ type: 'item.completed', item: { type: 'file_change', changes: item.changes } });
    else if (item.type !== 'reasoning')
      emit({
        type: 'relay.activity',
        summary:
          item.type === 'mcpToolCall'
            ? `${completed ? 'Finished' : 'Calling'} ${item.server}/${item.tool}`
            : item.type === 'webSearch'
              ? `Searching: ${item.query || ''}`
              : `${completed ? 'Finished' : 'Starting'} ${item.type}`,
        details: JSON.stringify(item),
      });
  }
  if (method === 'turn/completed')
    completed(
      params.turn.status === 'completed'
        ? null
        : params.turn.error?.message || `Turn ${params.turn.status}`,
    ).catch(fail);
  if (method === 'error' && !params.willRetry)
    fail(new Error(params.error?.message || 'Codex session error'));
});
child.stderr.pipe(process.stderr);
child.stdin.on('error', fail);
child.on('error', fail);
child.on('close', (code) => {
  if (!done) {
    emit({ type: 'relay.error', error: `Native harness exited ${code} before completion` });
    process.exit(1);
  }
});
const poll = setInterval(() => {
  if (threadId && !done) drain().catch(fail);
}, 100);
try {
  if (spec.harness === 'codex') {
    await request('initialize', { clientInfo: { name: 'relay', version: '0.1.0' } });
    send({ method: 'initialized' });
    const result = await request(spec.sessionId ? 'thread/resume' : 'thread/start', {
      ...(spec.sessionId ? { threadId: spec.sessionId } : {}),
      cwd: spec.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(spec.model ? { model: spec.model } : {}),
    });
    threadId = result.thread.id;
    emit({ type: 'relay.session', sessionId: threadId, model: result.model });
    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: spec.prompt }],
      cwd: spec.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      outputSchema: spec.schema,
      ...(spec.model ? { model: spec.model } : {}),
    });
    turnId = turn.turn.id;
  } else {
    threadId = spec.sessionId;
    emit({ type: 'relay.session', sessionId: threadId });
    await request('prompt', { message: spec.prompt });
  }
  emit({ type: 'relay.ready' });
} catch (error) {
  fail(error);
}
