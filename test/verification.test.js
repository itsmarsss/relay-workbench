import { verificationReport } from '../public/verification-report.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVerification } from '../server/verification.js';
import { validateConfig, handoffSchema } from '../server/domain.js';
import { developmentAccess } from '../server/access.js';

test('agent verification is the default and command mode is explicit', () => {
  const profile = { id: 'one', name: 'One', path: '/tmp/one' };
  assert.equal(
    validateConfig({ repositories: [profile] }).repositories[0].verificationMode,
    'agent',
  );
  assert.throws(
    () => validateConfig({ repositories: [{ ...profile, verificationMode: 'unknown' }] }),
    /verification mode/,
  );
  assert.equal(
    developmentAccess({ verificationContext: { executionAccess: 'host' } }, 'verify').elevated,
    true,
  );
  assert.equal(
    developmentAccess({ verificationContext: { executionAccess: 'host' } }, 'review').elevated,
    true,
  );
});
test('verification must prove every repository and requirement with passing executed evidence', () => {
  const entries = ['one', 'two'].map((id) => ({ repository: { id } }));
  const report = {
    checks: entries.map((e) => ({
      repositoryId: e.repository.id,
      command: 'custom-check',
      args: [],
      cwd: '/tmp/source',
      code: 0,
      summary: 'Passed',
    })),
    requirements: entries.map((e, index) => ({
      repositoryId: e.repository.id,
      source: 'AGENTS.md',
      requirement: 'Required check',
      checkIndices: [index],
    })),
  };
  assert.equal(validateVerification({ verification: report }, entries, true), report);
  for (const mutate of [
    (r) => (r.checks[0].code = 1),
    (r) => r.requirements.pop(),
    (r) => (r.requirements[0].checkIndices = [1]),
    (r) => (r.requirements[0].source = ''),
    (r) => (r.checks = []),
  ]) {
    const copy = structuredClone(report);
    mutate(copy);
    assert.throws(() => validateVerification({ verification: copy }, entries, true));
  }
  assert.throws(
    () => validateVerification({ verification: report }, entries, false),
    /tool execution/,
  );
});

test('verification evidence is visible and escaped in handoffs', () => {
  const html = verificationReport({
    checks: [
      {
        repositoryId: 'repo',
        command: '<command>',
        args: ['<arg>'],
        cwd: '/tmp/path',
        code: 0,
        summary: 'All passed',
      },
    ],
    requirements: [
      {
        repositoryId: 'repo',
        source: 'AGENTS.md',
        requirement: 'Run required checks',
        checkIndices: [0],
      },
    ],
  });
  assert.match(html, /Checks performed/);
  assert.match(html, /AGENTS.md/);
  assert.match(html, /&lt;command&gt;/);
  assert.doesNotMatch(html, /<command>/);
});

test('mixed workspaces preserve explicitly configured command requirements', () => {
  const entry = {
    repository: {
      id: 'one',
      verificationMode: 'commands',
      checks: [{ command: 'required-check', args: ['all'] }],
    },
  };
  const report = {
    checks: [
      {
        repositoryId: 'one',
        command: 'other-check',
        args: [],
        cwd: '/tmp/source',
        code: 0,
        summary: 'Passed',
      },
    ],
    requirements: [
      {
        repositoryId: 'one',
        source: 'profile',
        requirement: 'Configured check',
        checkIndices: [0],
      },
    ],
  };
  assert.throws(
    () => validateVerification({ verification: report }, [entry], true),
    /Configured commands/,
  );
  report.checks[0].command = 'required-check';
  report.checks[0].args = ['all'];
  assert.equal(validateVerification({ verification: report }, [entry], true), report);
});

test('verification output schema requires evidence without changing specialist schemas', () => {
  const verification = handoffSchema('verify');
  assert.ok(verification.required.includes('verification'));
  assert.equal(verification.properties.verification.additionalProperties, false);
  assert.deepEqual(Object.keys(verification.properties).sort(), [...verification.required].sort());
  assert.ok(!handoffSchema('implement').properties.verification);
});
