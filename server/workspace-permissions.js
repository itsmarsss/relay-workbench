import { createHash, randomUUID } from 'node:crypto';
import { requireValue, text, validateConfig } from './domain.js';
const key = 'workspace-config-proposals';
const fingerprint = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function configurationProposals(store) {
  const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : [];
}
function save(store, proposals) {
  store.db
    .prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
    .run(key, JSON.stringify(proposals));
  store.notify({ type: 'workspace_permission', taskId: '' });
}
export function proposeConfiguration(store, changes, reason, messageId) {
  requireValue(
    Array.isArray(changes) && changes.length > 0 && changes.length <= 30,
    'Provide 1–30 setting changes',
  );
  const next = structuredClone(store.config);
  const reviewed = [];
  const paths = new Set();
  for (const change of changes) {
    const path = change?.path;
    requireValue(
      Array.isArray(path) &&
        path.length > 0 &&
        path.length <= 8 &&
        path.every(
          (part) =>
            typeof part === 'string' &&
            part.length > 0 &&
            !['__proto__', 'prototype', 'constructor'].includes(part),
        ),
      'Invalid setting path',
    );
    requireValue(Object.hasOwn(change, 'value'), 'Provide a setting value');
    const identity = JSON.stringify(path);
    requireValue(!paths.has(identity), 'Duplicate setting path');
    paths.add(identity);
    let target = next;
    for (const part of path.slice(0, -1)) {
      requireValue(
        target && typeof target === 'object' && Object.hasOwn(target, part),
        'Unknown setting path',
      );
      target = target[part];
    }
    const field = path.at(-1);
    requireValue(
      target && typeof target === 'object' && Object.hasOwn(target, field),
      'Unknown setting path',
    );
    reviewed.push({
      path,
      before: structuredClone(target[field]),
      after: structuredClone(change.value),
    });
    target[field] = structuredClone(change.value);
  }
  // Reject overlapping parent/child changes; each review row must be independent.
  for (let a = 0; a < reviewed.length; a++)
    for (let b = a + 1; b < reviewed.length; b++) {
      const x = reviewed[a].path,
        y = reviewed[b].path;
      requireValue(
        !x.slice(0, Math.min(x.length, y.length)).every((part, index) => part === y[index]),
        'Overlapping setting paths',
      );
    }
  const normalized = validateConfig(next);
  requireValue(
    JSON.stringify(next) === JSON.stringify(normalized),
    'Proposed values must match the configuration schema',
  );
  requireValue(
    fingerprint(normalized) !== fingerprint(store.config),
    'These settings are already applied',
  );
  const all = configurationProposals(store);
  requireValue(
    all.filter((proposal) => proposal.status === 'pending').length < 20,
    'Review pending setting changes first',
    409,
  );
  const proposal = {
    id: randomUUID(),
    messageId,
    reason: text(reason, 'Reason', 2000),
    changes: reviewed,
    config: normalized,
    base: fingerprint(store.config),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  save(store, [
    ...all.filter((item) => item.status === 'pending'),
    ...all.filter((item) => item.status !== 'pending').slice(-79),
    proposal,
  ]);
  return {
    id: proposal.id,
    status: 'pending',
    reason: proposal.reason,
    changes: proposal.changes,
    message: 'No settings changed. The user must approve this exact proposal in Relay.',
  };
}
export function decideConfiguration(store, id, decision) {
  requireValue(['approve', 'reject'].includes(decision), 'Choose approve or reject');
  const all = configurationProposals(store);
  const proposal = all.find((item) => item.id === id);
  requireValue(proposal, 'Permission request not found', 404);
  requireValue(proposal.status === 'pending', 'This request has already been reviewed', 409);
  if (decision === 'approve') {
    requireValue(
      store.config.workspaceAgent.permissions.readSettings,
      'Read settings permission is required',
      403,
    );
    requireValue(
      store.config.workspaceAgent.permissions.proposeSettings,
      'Settings proposals are disabled',
      403,
    );
    requireValue(
      fingerprint(store.config) === proposal.base,
      'Settings changed since this proposal. Ask Relay for a fresh proposal.',
      409,
    );
    store.setConfig(proposal.config);
  }
  proposal.status = decision === 'approve' ? 'approved' : 'rejected';
  proposal.decidedAt = new Date().toISOString();
  proposal.decidedBy = 'user';
  save(store, all);
  return proposal;
}
