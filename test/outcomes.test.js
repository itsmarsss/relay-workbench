import test from 'node:test';
import assert from 'node:assert/strict';
import { routingOutcomes } from '../server/outcomes.js';
import { DEFAULT_CONFIG } from '../server/domain.js';
const handoff = { verdict: 'complete', findings: [] };
function task(id, harness = 'codex', model = '') {
  return {
    id,
    status: 'completed',
    repository: { id: 'repo' },
    attempts: [
      {
        id: 'implement',
        repositoryId: 'repo',
        stage: 'implement',
        harness,
        model,
        status: 'complete',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:02Z',
        handoff,
      },
      { stage: 'verify', harness: 'checks', status: 'complete', handoff },
      {
        stage: 'review',
        repositoryId: 'repo',
        harness: 'claude',
        model: '',
        status: 'complete',
        handoff,
      },
    ],
  };
}
test('routing advice requires settled matching evidence and never mutates configuration', () => {
  const config = structuredClone(DEFAULT_CONFIG),
    original = JSON.stringify(config);
  assert.equal(routingOutcomes([task('a')], config).recommendations.length, 0);
  const tasks = [
    task('a'),
    task('b'),
    task('c'),
    { ...task('demo'), demo: true },
    task('unknown', 'pi', undefined),
  ];
  delete tasks[4].attempts[0].model;
  const report = routingOutcomes(tasks, config, 'repo');
  const advice = report.recommendations.find((r) => r.stage === 'implement');
  assert.equal(advice.harness, 'codex');
  assert.equal(advice.samples, 3);
  assert.equal(report.rows.find((r) => r.harness === 'codex').medianMs, 2000);
  assert.equal(report.rows.find((r) => r.harness === 'pi').eligible, false);
  assert.equal(routingOutcomes(tasks, config, 'other').rows.length, 0);
  assert.equal(JSON.stringify(config), original);
  config.harnesses.codex.model = 'changed-model';
  assert.equal(
    routingOutcomes(tasks, config).recommendations.some((r) => r.harness === 'codex'),
    false,
  );
});
test('failed checks, review findings, unfinished and interrupted attempts stay distinct', () => {
  const failed = task('failed');
  failed.attempts[1].handoff = { verdict: 'changes_requested' };
  const findings = task('findings');
  findings.attempts[2].handoff = { ...handoff, findings: [{ summary: 'bug' }] };
  const pending = task('pending');
  pending.attempts = pending.attempts.slice(0, 1);
  const interrupted = task('interrupted');
  interrupted.attempts[0].status = 'interrupted';
  const row = routingOutcomes([failed, findings, pending, interrupted], DEFAULT_CONFIG).rows.find(
    (r) => r.harness === 'codex',
  );
  assert.equal(row.failed, 2);
  assert.equal(row.pending, 1);
  assert.equal(row.interrupted, 1);
  assert.equal(row.successful, 0);
  assert.equal(row.eligible, false);
  const review = routingOutcomes(
    [failed, findings, pending, interrupted],
    DEFAULT_CONFIG,
  ).rows.find((r) => r.stage === 'review');
  assert.equal(review.successful, 3, 'Finding defects must not penalize the reviewer');
});
