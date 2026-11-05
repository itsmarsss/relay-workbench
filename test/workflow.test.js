import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowColumn, workflowBoard, nextStep } from '../public/workflow.js';

test('workflow lanes reflect gates, stages, and control states', () => {
  const cases = [
    ['draft', 'triage', 'backlog'],
    ['running', 'investigate', 'discovery'],
    ['queued', 'plan', 'discovery'],
    ['awaiting_plan', 'plan', 'approach'],
    ['running', 'implement', 'progress'],
    ['queued', 'verify', 'progress'],
    ['running', 'review', 'review'],
    ['awaiting_final', 'review', 'final'],
    ['completed', 'review', 'done'],
    ['paused', 'review', 'attention'],
    ['manual', 'verify', 'attention'],
    ['blocked', 'implement', 'attention'],
    ['interrupted', 'triage', 'attention'],
    ['cancelled', 'plan', 'cancelled'],
  ];
  for (const [status, stage, lane] of cases) assert.equal(workflowColumn({ status, stage }), lane);
  assert.equal(nextStep({ status: 'manual' }), 'You have control');
});
test('board cards escape ticket content and expose the next action', () => {
  const html = workflowBoard([
    {
      id: 'example',
      title: '<script>unsafe</script>',
      status: 'awaiting_plan',
      stage: 'plan',
      repository: { name: 'Fixture' },
      routing: { plan: 'claude' },
      updatedAt: new Date().toISOString(),
      latestSummary: 'Evidence <b>retained</b>',
    },
  ]);
  assert.match(html, /&lt;script&gt;unsafe/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Choose an approach/);
});
