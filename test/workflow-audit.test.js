import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSummary } from '../public/task-summary.js';
import { handoffList, executionLogs } from '../public/task-panels.js';
import { liveProgress } from '../public/live-progress.js';
import { workflowBoard, nextStep } from '../public/workflow.js';
import { statusNames } from '../public/ui.js';
import { overrideStatuses } from '../public/task-status.js';

test('publication summary, timers, logs and handoffs follow the same run', () => {
  const delivery = {
    id: 'prepared',
    stage: 'verify',
    auxiliary: true,
    status: 'running',
    harness: 'codex',
    startedAt: '2026-01-01T01:00:00Z',
    summary: 'Scoped checks in progress',
    handoff: { verdict: 'complete', summary: 'Publication evidence' },
  };
  const task = {
    id: 'task',
    title: 'Task',
    status: 'completed',
    stage: 'review',
    routing: { review: 'claude' },
    repository: { id: 'repo', name: 'Repo' },
    attempts: [
      {
        id: 'core',
        stage: 'review',
        status: 'complete',
        harness: 'claude',
        startedAt: '2026-01-01T00:00:00Z',
      },
    ],
    delivery,
    deliveryRuns: [delivery],
  };
  const events = [
    { type: 'transcript', attemptId: 'prepared', text: 'New publication output' },
    { type: 'transcript', attemptId: 'core', text: 'Old review output' },
  ];
  assert.match(taskSummary(task), /Publishing · checks/);
  assert.doesNotMatch(taskSummary(task), /Accepted. No action needed/);
  assert.match(liveProgress(task), /Publishing · checks/);
  assert.match(handoffList(task), /Publication evidence/);
  assert.match(executionLogs(task, events), /New publication output/);
  assert.doesNotMatch(executionLogs(task, events), /Old review output/);
  assert.match(workflowBoard([task]), /aria-label="Codex"/);
  task.delivery = { ...delivery, status: 'blocked', summary: 'Missing capability' };
  assert.match(taskSummary(task), /Publishing needs attention/);
  assert.match(taskSummary(task), /Missing capability/);
  assert.equal(nextStep(task), 'Inspect publishing blocker');
});

test('manual status labels match automatic badges and verification shows its agent', () => {
  for (const [status, label] of Object.entries(overrideStatuses))
    assert.equal(statusNames[status], label);
  const task = {
    id: 'task',
    title: 'Task',
    status: 'running',
    stage: 'verify',
    routing: { implement: 'codex' },
    repository: { name: 'Repo' },
    attempts: [
      { id: 'verify', stage: 'verify', role: 'verifier', harness: 'codex', status: 'running' },
    ],
  };
  assert.match(nextStep(task), /codex · Verification agent/);
  assert.match(workflowBoard([task]), /aria-label="Codex"/);
  assert.doesNotMatch(taskSummary(task), /configured repository checks/);
});

test('task list summaries stay compact and retain the actual current agent', async () => {
  const { taskListSummary } = await import('../server/app.js');
  const task = {
    id: 't',
    status: 'completed',
    repository: { id: 'repo', name: 'Repo' },
    attempts: [
      { id: 'core', stage: 'review', harness: 'claude', handoff: { summary: 'Old core result' } },
    ],
    delivery: {
      id: 'pub',
      stage: 'publish',
      status: 'running',
      harness: 'codex',
      startedAt: '2026-01-01',
      summary: 'Preparing PR',
    },
    deliveryRuns: [{ id: 'poll', stage: 'monitor', details: 'Large polling output' }],
  };
  const summary = taskListSummary(task);
  assert.equal(summary.deliveryRuns, undefined);
  assert.equal(summary.attempts, undefined);
  assert.equal(summary.currentRun.harness, 'codex');
  assert.equal(summary.latestSummary, 'Preparing PR');
  assert.doesNotMatch(JSON.stringify(summary), /Large polling output/);
});
