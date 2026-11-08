import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeHarness,
  demoHandoff,
  buildPrompt,
  buildInvocation,
  decodeEvent,
} from '../server/harness.js';
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
          ? {
              type: 'result',
              structured_output: handoff,
              modelUsage: { alias: { canonicalModel: 'reported-example-model' } },
            }
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
    const models = [];
    const result = await executeHarness({
      task,
      stage: 'investigate',
      harness,
      config,
      directory,
      attemptId: harness,
      onEvent: (event) => events.push(event),
      onModel: (model) => models.push(model),
    });
    assert.equal(result.summary, handoff.summary);
    if (harness === 'claude') assert.deepEqual(models, ['reported-example-model']);
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

test('Claude development capabilities and denied tool results stay explicit', () => {
  const locked = buildInvocation(
    'claude',
    { command: 'claude' },
    '/tmp/schema',
    'investigate',
    null,
    { writable: false, writableRoots: [] },
  );
  assert.ok(!locked.args.includes('Bash'));
  const allowed = buildInvocation(
    'claude',
    { command: 'claude' },
    '/tmp/schema',
    'investigate',
    null,
    { writable: true, writableRoots: ['/tmp/runtime'] },
  );
  assert.ok(allowed.args.includes('bypassPermissions'));
  assert.ok(locked.args.includes('bypassPermissions'));
  const settings = JSON.parse(allowed.args[allowed.args.indexOf('--settings') + 1]);
  assert.equal(settings.sandbox.enabled, false);
  const event = decodeEvent(
    'claude',
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: true, content: 'Bash denied: approval unavailable' },
        ],
      },
    }),
  );
  assert.match(event.details, /approval unavailable/);
  assert.equal(event.kind, 'tool');
  const task = newTask({ title: 'Debug', demo: true }, DEFAULT_CONFIG);
  task.debugContext = {
    blockedStage: 'implement',
    recentCommandResults: [{ details: 'recorded log output' }],
  };
  assert.match(buildPrompt(task, 'investigate'), /DEDICATED DEBUGGER/);
  assert.match(buildPrompt(task, 'investigate'), /recorded log output/);
});

test('continuation prompts preserve completed work and require outstanding evidence', () => {
  const task = newTask({ title: 'Resume', demo: true }, DEFAULT_CONFIG);
  task.continuationContext = {
    completedWork: { details: 'Saved implementation' },
    diagnosis: { summary: 'Tool restored' },
  };
  const prompt = buildPrompt(task, 'implement');
  assert.match(prompt, /TARGETED CONTINUATION/);
  assert.match(prompt, /do not start the stage over/);
  assert.match(prompt, /Saved implementation/);
  assert.match(prompt, /mandatory full verification/);
});

test('elevated debugger adapters use host permissions explicitly', () => {
  const access = { elevated: true, writable: true, networkAccess: true };
  const codex = buildInvocation(
    'codex',
    { command: 'codex' },
    '/tmp/schema',
    'investigate',
    undefined,
    access,
  );
  assert.ok(codex.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!codex.args.some((a) => a.includes('sandbox_workspace_write')));
  const claude = buildInvocation(
    'claude',
    { command: 'claude' },
    '/tmp/schema',
    'investigate',
    undefined,
    access,
  );
  assert.ok(claude.args.includes('bypassPermissions'));
  const pi = buildInvocation(
    'pi',
    { command: 'pi' },
    '/tmp/schema',
    'investigate',
    undefined,
    access,
  );
  assert.ok(pi.args.includes('read,bash,edit,write,grep,find,ls'));
  const task = newTask({ title: 'Diagnostic fixture', demo: true }, DEFAULT_CONFIG);
  task.debugContext = { executionAccess: 'host' };
  assert.match(buildPrompt(task, 'investigate'), /no preconfigured command list is required/);
  assert.match(
    buildPrompt(task, 'investigate'),
    /Do not return verification_requested to outsource/,
  );
});

test('publication preparation can request verification and preserves autonomous recovery instructions', async () => {
  const { validateHandoff, handoffSchema } = await import('../server/domain.js');
  const task = newTask({ title: 'Publish accepted change', demo: true }, DEFAULT_CONFIG);
  task.publicationContext = {
    phase: 'preparing',
    approvalBaseline: { acceptedSource: '/private/runtime/accepted.json' },
  };
  const result = {
    ...demoHandoff(task, 'implement'),
    verdict: 'verification_requested',
    preparation: { baseCommit: 'a'.repeat(40), scope: 'routine', summary: 'Updated branch' },
  };
  assert.equal(validateHandoff(result, 'publish').verdict, 'verification_requested');
  assert.ok(handoffSchema('publish').properties.preparation);
  const prompt = buildPrompt(task, 'publish');
  assert.match(prompt, /rebase the assigned branch/);
  assert.match(prompt, /DO NOT PUSH OR PUBLISH yet/);
  assert.match(prompt, /Do not invent a human approval requirement/);
  assert.doesNotMatch(prompt, /Do not edit source, regenerate files.*rebase/);
  assert.match(
    buildPrompt(task, 'review'),
    /independently compare the original accepted source snapshot/,
  );
});

test('every stage runs on the host even for legacy restricted repository profiles', async () => {
  const { developmentAccess } = await import('../server/access.js');
  const task = newTask({ title: 'Host execution', demo: true }, DEFAULT_CONFIG);
  task.repository.developmentAccess = {
    analysisCommands: false,
    networkAccess: false,
    writableRoots: [],
  };
  for (const stage of [
    'triage',
    'investigate',
    'plan',
    'implement',
    'verify',
    'review',
    'publish',
    'monitor',
  ]) {
    assert.deepEqual(developmentAccess(task, stage), {
      elevated: true,
      writable: true,
      networkAccess: true,
      writableRoots: [],
    });
    assert.ok(
      buildInvocation('codex', { command: 'codex' }, '/tmp/schema', stage).args.includes(
        '--dangerously-bypass-approvals-and-sandbox',
      ),
    );
    const claude = buildInvocation('claude', { command: 'claude' }, '/tmp/schema', stage);
    assert.ok(claude.args.includes('bypassPermissions'));
    assert.equal(
      JSON.parse(claude.args[claude.args.indexOf('--settings') + 1]).sandbox.enabled,
      false,
    );
    assert.ok(
      buildInvocation('pi', { command: 'pi' }, '/tmp/schema', stage).args.includes(
        'read,bash,edit,write,grep,find,ls',
      ),
    );
  }
  const prompt = buildPrompt(task, 'implement');
  assert.match(prompt, /Historical sandbox denials are not current blockers/);
  assert.doesNotMatch(prompt, /return blocked with command evidence so the elevated debugger/);
  assert.match(prompt, /Analysis stages must not change tracked or untracked source files/);
});
