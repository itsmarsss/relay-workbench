import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeHarness, demoHandoff, buildPrompt } from '../server/harness.js';
import { DEFAULT_CONFIG, newTask } from '../server/domain.js';

test('each adapter executes a real subprocess and parses its native stream', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-adapters-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = newTask({ title: 'Fixture handoff', demo: true }, DEFAULT_CONFIG);
  task.workspace = directory;
  const handoff = demoHandoff(task, 'investigate');
  for (const harness of ['codex', 'claude', 'pi']) {
    const config = structuredClone(DEFAULT_CONFIG);
    const binary = join(directory, `${harness}.js`);
    const event =
      harness === 'codex'
        ? { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(handoff) } }
        : harness === 'claude'
          ? { type: 'result', structured_output: handoff }
          : {
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: JSON.stringify(handoff) }],
              },
            };
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(event) + '\n')}));\n`,
      { mode: 0o700 },
    );
    config.harnesses[harness].command = binary;
    const events = [];
    const result = await executeHarness({
      task,
      stage: 'investigate',
      harness,
      config,
      directory,
      attemptId: harness,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.summary, handoff.summary);
    assert.ok(events.some((e) => e.type === 'transcript'));
    assert.ok(events.some((e) => e.type === 'activity'));
  }
});
test('malformed structured output and nonzero exits never count as success', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-adapter-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = newTask({ title: 'Bad response', demo: true }, DEFAULT_CONFIG);
  task.workspace = directory;
  const config = structuredClone(DEFAULT_CONFIG);
  const binary = join(directory, 'bad.js');
  config.harnesses.codex.command = binary;
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'not-json'}})));`,
    { mode: 0o700 },
  );
  await assert.rejects(
    executeHarness({
      task,
      stage: 'investigate',
      harness: 'codex',
      config,
      directory,
      attemptId: 'bad-json',
      onEvent() {},
    }),
    /invalid structured/,
  );
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.exit(7));`,
    { mode: 0o700 },
  );
  await assert.rejects(
    executeHarness({
      task,
      stage: 'investigate',
      harness: 'codex',
      config,
      directory,
      attemptId: 'bad-exit',
      onEvent() {},
    }),
    /exited 7/,
  );
});
test('approval notes and human feedback survive prompt handoff', () => {
  const task = newTask({ title: 'A task', demo: true }, DEFAULT_CONFIG);
  task.approvals.push({ type: 'approach', note: 'Preserve the public interface.' });
  task.messages.push({ text: 'Cover empty input too.' });
  const prompt = buildPrompt(task, 'implement');
  assert.match(prompt, /Preserve the public interface/);
  assert.match(prompt, /Cover empty input too/);
  assert.match(prompt, /untrusted task context/);
});
