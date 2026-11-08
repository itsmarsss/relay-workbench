import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpComposer } from '../public/follow-up.js';
import { workflowStages } from '../public/task-panels.js';
import { deliveryWorkflowStages } from '../public/publication.js';
import { activityRunNavigation } from '../public/activity-runs.js';

test('completed task exposes questions, edits and PR updates without raw status text', () => {
  const task = { status: 'completed', repository: { id: 'repo', name: 'Example' }, attempts: [] };
  const html = followUpComposer(task);
  for (const label of ['Continue work', 'Ask', 'Request edits', 'Update PR'])
    assert.match(html, new RegExp(label));
  assert.equal(followUpComposer({ ...task, status: 'running' }), '');
  const busy = followUpComposer({ ...task, delivery: { status: 'running' } });
  assert.match(busy, /value="changes"[^>]*disabled/);
});

test('workflow includes completed verification agents and resets follow-up progress', () => {
  const run = {
    id: 'v',
    stage: 'verify',
    role: 'verifier',
    harness: 'codex',
    status: 'complete',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
    handoff: { verdict: 'complete' },
  };
  const task = {
    status: 'completed',
    stage: 'review',
    attempts: [run],
    repository: { id: 'repo' },
    publication: { state: 'open' },
    delivery: { ...run, stage: 'publish', phase: 'monitoring' },
  };
  const html = workflowStages(task);
  assert.match(html, /data-stage-state="complete"[^]*Verification agent/);
  assert.match(html, /Codex/);
  assert.match(html, /1m/);
  assert.match(deliveryWorkflowStages(task), /Published/);
  task.followUpContext = { startedAt: '2026-01-02T00:00:00Z' };
  assert.doesNotMatch(workflowStages(task), /Verification agent/);
  assert.doesNotMatch(deliveryWorkflowStages(task), /Published/);
});

test('history rows use readable provider names, timing, and explicit completion marks', () => {
  const run = {
    id: 'p',
    stage: 'publish',
    auxiliary: true,
    harness: 'codex',
    status: 'complete',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:02:00Z',
  };
  const html = activityRunNavigation({ attempts: [], deliveryRuns: [run] }, run, 'latest');
  assert.match(html, /Publish/);
  assert.match(html, /Codex/);
  assert.match(html, /Complete/);
  assert.match(html, /2m/);
  assert.match(html, /✓/);
  assert.doesNotMatch(html, /codex · complete/);
});
