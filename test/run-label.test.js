import test from 'node:test';
import assert from 'node:assert/strict';
import { runLabel } from '../public/run-label.js';
import { activityRunNavigation, activityRunHeader } from '../public/activity-runs.js';
import { liveProgress } from '../public/live-progress.js';
import { executionMap } from '../public/execution-map.js';
import { taskSummary } from '../public/task-summary.js';
import { handoffList, workflowStages } from '../public/task-panels.js';

test('verification agent has the same name in history, activity, counters, workflow, graph and handoffs', () => {
  for (const harness of ['codex', 'claude', 'pi']) {
    const attempt = {
      id: 'agent',
      role: 'verifier',
      harness,
      stage: 'verify',
      status: 'running',
      executionAccess: 'host',
      startedAt: '2026-01-01T00:00:00Z',
    };
    const task = {
      id: 'task',
      title: 'Verify the implementation',
      status: 'running',
      stage: 'verify',
      attempts: [attempt],
      routing: { implement: 'codex' },
    };
    assert.equal(runLabel(attempt), 'Verification agent');
    const report = {
      summary: 'Required checks passed',
      verdict: 'complete',
      files: [],
      evidence: [],
      risks: [],
      findings: [],
    };
    const surfaces = [
      activityRunNavigation(task, attempt, 'latest'),
      activityRunHeader(attempt, []),
      liveProgress(task),
      executionMap(task),
      taskSummary(task),
      workflowStages(task),
      handoffList({ ...task, attempts: [{ ...attempt, handoff: report }] }),
    ];
    for (const html of surfaces) {
      assert.match(html, /Verification agent/);
      assert.doesNotMatch(html, /Host checks|Host verification/);
    }
  }
});
test('configured and historical script runs are never presented as agents', () => {
  for (const attempt of [
    { role: 'verifier', harness: 'checks' },
    { role: 'verifier' },
    { harness: 'checks' },
  ])
    assert.equal(runLabel(attempt), 'Configured checks');
  assert.equal(runLabel({ role: 'debug', harness: 'codex', stage: 'implement' }), 'Debugger');
  assert.equal(runLabel({ stage: 'verify', harness: 'codex' }), 'Verification');
});
