import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availablePercent,
  fetchStorage,
  formatBytes,
  parsePolicyDraft,
  policyDraft,
  saveStoragePolicy,
  scanStorage,
  type StoragePolicy,
} from './storage.ts';
const policy: StoragePolicy = {
  enabled: true,
  warningPercent: 10,
  criticalPercent: 3,
  warningBytes: 10737418240,
  criticalBytes: 2147483648,
  monitoredPaths: [],
};
test('storage thresholds round trip and reject invalid edits', () => {
  assert.deepEqual(parsePolicyDraft(policyDraft(policy)), policy);
  assert.throws(
    () => parsePolicyDraft({ ...policyDraft(policy), warningPercent: '' }),
    /Enter every/,
  );
  assert.throws(
    () => parsePolicyDraft({ ...policyDraft(policy), criticalPercent: '12' }),
    /Critical/,
  );
  assert.throws(
    () => parsePolicyDraft({ ...policyDraft(policy), warningPercent: '1.5' }),
    /whole numbers/,
  );
  assert.throws(
    () => parsePolicyDraft({ ...policyDraft(policy), warningGiB: 'Infinity' }),
    /nonnegative/,
  );
});
test('large filesystem capacities retain precision', () => {
  assert.equal(formatBytes('18446744073709551615'), '16.0 EB');
  assert.equal(
    availablePercent({ totalBytes: '18446744073709551615', availableBytes: '9223372036854775807' }),
    49.99,
  );
});
test('storage API preserves authorization and rejects stale revisions', async () => {
  const original = globalThis.fetch;
  let headers: HeadersInit | undefined;
  globalThis.fetch = async (_url, init) => {
    headers = init?.headers;
    return new Response(JSON.stringify({ error: 'Policy changed' }), { status: 409 });
  };
  try {
    await assert.rejects(saveStoragePolicy('token', 'revision', policy), /Policy changed/);
    assert.equal((headers as Record<string, string>)['If-Match'], 'revision');
    assert.equal((headers as Record<string, string>)['X-Relay-Token'], 'token');
  } finally {
    globalThis.fetch = original;
  }
});
test('storage reports reject malformed capacity data', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        policy,
        revision: 'a'.repeat(64),
        scope: 'Relay data volume',
        admissionEnforced: false,
        automaticCleanup: false,
        pressure: {
          state: 'normal',
          message: 'ok',
          warningThreshold: '100',
          criticalThreshold: '20',
          space: { totalBytes: '10', availableBytes: '11' },
        },
      }),
      { status: 200 },
    );
  try {
    await assert.rejects(fetchStorage(), /invalid/);
  } finally {
    globalThis.fetch = original;
  }
});

test('path scans use the saved revision and validate returned evidence', async () => {
  const original = globalThis.fetch;
  let sent: RequestInit | undefined,
    url = '';
  globalThis.fetch = async (input, init) => {
    url = String(input);
    sent = init;
    return new Response(
      JSON.stringify({
        path: '/example',
        revision: 'a'.repeat(64),
        scan: {
          allocatedBytes: '4096',
          logicalBytes: '8',
          files: 1,
          directories: 0,
          skippedSymlinks: 0,
          skippedHardlinks: 0,
          skippedMounts: 0,
          complete: true,
        },
        pressure: { state: 'normal' },
      }),
      { status: 200 },
    );
  };
  try {
    await assert.rejects(scanStorage('token', 0, 'a'.repeat(64)), /invalid/);
    assert.match(url, /index=0/);
    assert.equal((sent!.headers as Record<string, string>)['X-Relay-Token'], 'token');
  } finally {
    globalThis.fetch = original;
  }
});
