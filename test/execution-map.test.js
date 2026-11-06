import test from 'node:test';
import assert from 'node:assert/strict';
import { taskRoute, parseTaskRoute, taskTabs } from '../public/task-route.js';
import { executionMap, executionNodes, debuggerStep } from '../public/execution-map.js';
test('all task tabs roundtrip in URLs and legacy links retain overview', () => {
  const id = 'a1b2-1234';
  for (const tab of taskTabs) assert.deepEqual(parseTaskRoute(taskRoute(id, tab)), { id, tab });
  assert.deepEqual(parseTaskRoute(`#task/${id}`), { id, tab: 'overview' });
  assert.deepEqual(parseTaskRoute(`#task/${id}/unknown`), { id, tab: 'overview' });
  assert.equal(parseTaskRoute('#tasks'), null);
});
test('execution tree shows diagnostic branches, continuations and repairs without claiming legacy causality', () => {
  const task = {
    status: 'running',
    stage: 'implement',
    approvals: [],
    attempts: [
      {
        id: 'a',
        stage: 'implement',
        status: 'complete',
        harness: 'codex',
        handoff: { verdict: 'blocked', summary: 'Needs runtime' },
      },
      {
        id: 'b',
        stage: 'implement',
        role: 'debug',
        status: 'complete',
        harness: 'codex',
        parentAttemptId: 'a',
        relation: 'Diagnosis',
        handoff: { verdict: 'complete', summary: 'Runtime restored' },
      },
      {
        id: 'c',
        stage: 'implement',
        status: 'running',
        harness: 'codex',
        actualModel: 'model-example',
        parentAttemptId: 'b',
        relation: 'Continue after diagnosis',
        startedAt: new Date().toISOString(),
      },
    ],
  };
  const nodes = executionNodes(task);
  assert.equal(nodes[1].parentNumber, 1);
  assert.equal(nodes[1].inferred, false);
  const html = executionMap(task);
  assert.match(html, /debug-branch/);
  assert.match(html, /Continue after diagnosis/);
  assert.match(html, /model-example/);
  assert.match(html, /From run 2/);
  task.attempts[2].role = 'debug';
  assert.match(debuggerStep(task), /Debugger/);
  assert.match(debuggerStep(task), /model-example/);
  task.status = 'blocked';
  assert.equal(debuggerStep(task), '');
  task.attempts[2].actualModel = '<script>bad</script>';
  assert.doesNotMatch(executionMap(task), /<script>/);
  const legacy = executionNodes({
    attempts: [{ stage: 'verify' }, { stage: 'implement', round: 1 }],
  });
  assert.equal(legacy[1].inferred, true);
  assert.equal(legacy[1].relation, 'Repair / backtrack');
});
