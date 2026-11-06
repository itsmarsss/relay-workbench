import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationEvidence, PUBLICATION_CHECK_SCOPE } from '../server/publication-evidence.js';
test('publication evidence survives base-only changes but rejects changed checks and guidance', () => {
  const original = [
    {
      id: 'repo',
      workspace: '/repo',
      baseCommit: 'old',
      instructions: 'Run affected tests',
      checks: [],
      mode: 'agent',
    },
  ];
  const run = {
    id: 'accepted',
    stage: 'verify',
    verificationSignature: JSON.stringify(original),
    beforeFingerprint: 'before',
    verificationEvidence: [{ code: 0, command: 'check' }],
  };
  const current = JSON.stringify([{ ...original[0], baseCommit: 'new' }]);
  assert.equal(publicationEvidence({ attempts: [run] }, current)[0].reusable, true);
  assert.equal(
    publicationEvidence(
      { attempts: [run] },
      JSON.stringify([{ ...original[0], instructions: 'Different policy' }]),
    )[0].reusable,
    false,
  );
  assert.equal(
    publicationEvidence(
      { deliveryRuns: [run] },
      JSON.stringify([{ ...original[0], checks: [{ command: 'changed' }] }]),
    )[0].reusable,
    false,
  );
  assert.equal(publicationEvidence({ deliveryRuns: [run] }, current)[0].attemptId, 'accepted');
  assert.equal(publicationEvidence({ attempts: [run] }, 'invalid')[0].reusable, false);
  assert.match(PUBLICATION_CHECK_SCOPE, /not a new implementation verification campaign/);
  assert.match(PUBLICATION_CHECK_SCOPE, /targeted fresh checks/);
});
