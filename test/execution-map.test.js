import test from 'node:test';
import assert from 'node:assert/strict';
import { taskRoute, parseTaskRoute, taskTabs } from '../public/task-route.js';
import {
  executionMap,
  executionNodes,
  debuggerStep,
  graphLayout,
} from '../public/execution-map.js';
test('all task tabs roundtrip in URLs and legacy links retain overview', () => {
  const id = 'a1b2-1234';
  for (const tab of taskTabs) assert.deepEqual(parseTaskRoute(taskRoute(id, tab)), { id, tab });
  assert.deepEqual(parseTaskRoute(`#task/${id}`), { id, tab: 'overview' });
  assert.deepEqual(parseTaskRoute(`#task/${id}/unknown`), { id, tab: 'overview' });
  assert.equal(parseTaskRoute('#tasks'), null);
});
test('side chat roundtrips in task URLs without changing legacy routes', () => {
  const id = 'a1b2-1234';
  for (const tab of taskTabs) {
    assert.equal(taskRoute(id, tab, true), `#task/${id}/${tab}?chat=1`);
    assert.deepEqual(parseTaskRoute(taskRoute(id, tab, true)), { id, tab, sideChatOpen: true });
  }
  assert.deepEqual(parseTaskRoute(`#task/${id}?chat=1`), {
    id,
    tab: 'overview',
    sideChatOpen: true,
  });
  assert.deepEqual(parseTaskRoute(`#task/${id}/overview?chat=0`), { id, tab: 'overview' });
  assert.deepEqual(parseTaskRoute(`#task/${id}/overview?chat=unexpected`), { id, tab: 'overview' });
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

test('graph uses explicit connected nodes and a separate debugger lane', () => {
  const task = {
    attempts: [
      { id: 'a', stage: 'implement' },
      { id: 'b', parentAttemptId: 'a', role: 'debug', stage: 'implement' },
    ],
  };
  const graph = graphLayout(task);
  assert.equal(graph.edges[0].from, 1);
  assert.equal(graph.edges[0].to, 2);
  assert.notEqual(graph.nodes[0].x, graph.nodes[1].x);
  assert.match(graph.edges[0].path, /^M /);
  assert.match(executionMap(task), /marker-end=/);
  assert.match(executionMap(task), /role="button"/);
});

test('host verification has a distinct lane and generic command evidence', () => {
  const task = {
    attempts: [
      { id: 'code', stage: 'implement', harness: 'codex' },
      {
        id: 'debug',
        stage: 'implement',
        harness: 'claude',
        role: 'debug',
        parentAttemptId: 'code',
      },
      {
        id: 'host',
        stage: 'implement',
        harness: 'checks',
        role: 'verifier',
        parentAttemptId: 'debug',
        status: 'running',
      },
    ],
  };
  const graph = graphLayout(task);
  assert.equal(new Set(graph.nodes.map((n) => n.y)).size, 3);
  assert.ok(graph.nodes.every((n, i) => !i || n.y > graph.nodes[i - 1].y));
  const html = executionMap(task);
  assert.match(html, /Configured checks/);
  assert.match(html, /Configured commands/);
  assert.match(html, /graph-open-activity/);
});

test('causal graph packs siblings and routes long links outside cards', () => {
  const task = {
    attempts: [
      { id: 'a', stage: 'implement' },
      { id: 'b', stage: 'implement', role: 'debug', parentAttemptId: 'a' },
      { id: 'c', stage: 'verify', role: 'verifier', parentAttemptId: 'a' },
      { id: 'd', stage: 'implement', parentAttemptId: 'b' },
      { id: 'e', stage: 'review', parentAttemptId: 'a' },
    ],
  };
  const graph = graphLayout(task);
  assert.equal(graph.nodes[1].row, graph.nodes[2].row);
  assert.equal(graph.nodes[3].x, graph.nodes[0].x);
  for (const edge of graph.edges)
    assert.ok(graph.nodes[edge.to - 1].y > graph.nodes[edge.from - 1].y);
  assert.equal(new Set(graph.nodes.map((n) => `${n.x}:${n.y}`)).size, graph.nodes.length);
  assert.ok(graph.width < 1000);
  assert.match(executionMap(task, { selectedId: 'd' }), /graph-connection on-path/);
});
