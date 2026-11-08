import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeHarness, demoHandoff, resumeInvocation } from '../server/harness.js';
import { DEFAULT_CONFIG, newTask } from '../server/domain.js';

for (const [harness, development] of [
  ['codex', false],
  ['codex', true],
  ['codex', 'elevated'],
  ['codex', 'verification'],
  ['pi', false],
])
  test(`${harness} native protocol resumes and steers with development access ${development}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-native-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const task = newTask({ title: 'Protocol fixture', demo: true }, DEFAULT_CONFIG);
    task.demo = false;
    if (development)
      task.repository.developmentAccess = {
        analysisCommands: true,
        networkAccess: true,
        writableRoots: ['/tmp/logs'],
      };
    if (development === 'elevated') task.debugContext = { executionAccess: 'host' };
    if (development === 'verification') task.verificationContext = { executionAccess: 'host' };
    task.workspace = directory;
    const handoff = demoHandoff(task, 'investigate');
    const binary = join(directory, 'fixture.js');
    const recording = join(directory, 'requests.jsonl');
    await writeFile(
      binary,
      `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const emit=e=>console.log(JSON.stringify(e));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); appendFileSync(${JSON.stringify(recording)},line+'\\n');
 const method=r.method||r.type;
 const result=method==='thread/resume'?{thread:{id:'session-fixture'}}:method==='turn/start'?{turn:{id:'turn-fixture'}}:{};
 if(method==='initialized') return;
 if(method==='turn/start') emit({method:'item/started',params:{item:{type:'commandExecution',command:'example-check'}}});
 if(${JSON.stringify(harness)}==='codex') emit({id:r.id,result}); else emit({id:r.id,type:'response',success:true,data:{disposition:'queued'}});
 if(method==='turn/steer'||method==='steer') setTimeout(()=>{
   if(${JSON.stringify(harness)}==='codex') {
    emit({method:'item/completed',params:{item:{type:'agentMessage',text:${JSON.stringify(JSON.stringify(handoff))}}}});
    emit({method:'turn/completed',params:{turn:{status:'completed'}}});
   } else { emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(JSON.stringify(handoff))}}]}}); emit({type:'agent_end'}); }
 },150);
});`,
      { mode: 0o700 },
    );
    const config = structuredClone(DEFAULT_CONFIG);
    config.harnesses[harness].command = binary;
    let session;
    let steering;
    const activities = [];
    const result = await executeHarness({
      task,
      stage: development === 'verification' ? 'verify' : 'investigate',
      harness,
      config,
      directory,
      attemptId: randomUUID(),
      sessionId: 'session-fixture',
      onEvent(event) {
        activities.push(event);
      },
      onSession: (id) => (session = id),
      onControl: (control) => {
        if (control) steering = control(randomUUID(), 'Cover boundary values');
      },
      signal: AbortSignal.timeout(10000),
    });
    await steering;
    assert.equal(session, 'session-fixture');
    assert.equal(result.summary, handoff.summary);
    if (harness === 'codex')
      assert.ok(activities.some((e) => e.summary === 'Running: example-check'));
    const requests = (await readFile(recording, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    assert.ok(
      requests.some((r) => (r.method || r.type) === (harness === 'codex' ? 'turn/steer' : 'steer')),
    );
    if (harness === 'codex') {
      assert.equal(
        requests.find((r) => r.method === 'thread/resume').params.approvalPolicy,
        'never',
      );
      assert.equal(
        requests.find((r) => r.method === 'turn/start').params.sandboxPolicy.type,
        'dangerFullAccess',
      );
      assert.equal(
        requests.find((r) => r.method === 'thread/resume').params.sandbox,
        'danger-full-access',
      );
    }
  });

test('interactive native resume uses exact session and preserves approval limits', () => {
  assert.throws(() => resumeInvocation('codex', { command: 'codex' }, '--ephemeral'), /identifier/);
  for (const harness of ['codex', 'claude', 'pi']) {
    const invocation = resumeInvocation(
      harness,
      { command: harness, model: '' },
      'specific-session',
      false,
    );
    assert.ok(invocation.args.includes('specific-session'));
    assert.ok(!invocation.args.includes('--last'));
    if (harness === 'codex')
      assert.ok(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  }
});

test('interactive takeover retains configured development capabilities', () => {
  const invocation = resumeInvocation('codex', { command: 'codex' }, 'saved-session', false, {
    writable: true,
    networkAccess: true,
    writableRoots: ['/tmp/runtime'],
  });
  assert.ok(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!invocation.args.includes('--add-dir'));
});
