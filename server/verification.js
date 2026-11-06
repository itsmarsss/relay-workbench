import { requireValue } from './domain.js';

// This validates agent-reported evidence, never executes text from a handoff.
export function validateVerification(handoff, entries, toolEvidence, context = {}) {
  try {
    return validateReport(handoff, entries, toolEvidence, context);
  } catch (error) {
    error.code ||= 'VERIFICATION_REPORT_INVALID';
    error.report = handoff.verification;
    error.toolEvidence = toolEvidence;
    throw error;
  }
}
function sameCommand(a, b) {
  return (
    a.repositoryId === b.repositoryId &&
    a.cwd === b.cwd &&
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    a.code === b.code
  );
}
function validateReport(handoff, entries, toolEvidence, context) {
  const report = handoff.verification;
  requireValue(toolEvidence, 'Verification needs recorded tool execution, not a summary alone');
  requireValue(
    report &&
      Array.isArray(report.checks) &&
      report.checks.length > 0 &&
      report.checks.length <= 200,
    'Verification needs executed checks',
  );
  const ids = new Set(entries.map((entry) => entry.repository.id));
  for (const check of report.checks) {
    requireValue(
      ids.has(check.repositoryId) &&
        typeof check.command === 'string' &&
        check.command.trim() &&
        Array.isArray(check.args) &&
        check.args.every((arg) => typeof arg === 'string') &&
        typeof check.cwd === 'string' &&
        check.cwd.trim() &&
        Number.isInteger(check.code) &&
        typeof check.summary === 'string' &&
        check.summary.trim(),
      'Invalid verification command evidence',
    );
    if (check.code !== 0) {
      const error = new Error(
        `A failed verification check cannot pass the gate: ${check.command} exited ${check.code}`,
      );
      error.code = 'VERIFICATION_CHECK_FAILED';
      throw error;
    }
  }
  requireValue(
    Array.isArray(report.requirements) &&
      report.requirements.length > 0 &&
      report.requirements.length <= 200,
    'Verification needs requirements from repository guidance',
  );
  for (const requirement of report.requirements) {
    requireValue(
      ids.has(requirement.repositoryId) &&
        typeof requirement.source === 'string' &&
        requirement.source.trim() &&
        typeof requirement.requirement === 'string' &&
        requirement.requirement.trim() &&
        Array.isArray(requirement.checkIndices) &&
        requirement.checkIndices.length > 0 &&
        requirement.checkIndices.every(
          (index) =>
            Number.isInteger(index) &&
            report.checks[index]?.repositoryId === requirement.repositoryId,
        ),
      'Every verification requirement needs a source and matching check evidence',
    );
  }
  for (const id of ids)
    requireValue(
      report.requirements.some((requirement) => requirement.repositoryId === id),
      'Verification must cover every selected repository',
    );
  if (context.journal) {
    const latest = new Map();
    for (const record of context.journal)
      if (record.purpose !== 'diagnostic')
        latest.set(
          JSON.stringify([record.repositoryId, record.cwd, record.command, record.args]),
          record,
        );
    const failed = [...latest.values()].find(
      (r) => r.status === 'complete' && r.code !== 0 && r.purpose !== 'diagnostic',
    );
    if (failed) {
      const error = new Error(`A supervised check failed: ${failed.command} exited ${failed.code}`);
      error.code = 'VERIFICATION_CHECK_FAILED';
      throw error;
    }
  }
  const reuse = report.reuse ?? [];
  requireValue(
    Array.isArray(reuse) && reuse.length <= report.checks.length,
    'Invalid reused check evidence',
  );
  const reused = new Set();
  for (const item of reuse) {
    const check = report.checks[item.checkIndex];
    const prior = context.priorEvidence?.find((a) => a.attemptId === item.attemptId && a.reusable);
    requireValue(
      check &&
        prior &&
        !reused.has(item.checkIndex) &&
        typeof item.reason === 'string' &&
        item.reason.trim(),
      'Reused evidence needs an eligible source and impact explanation',
    );
    const evidence = [...(prior.checks ?? []), ...(prior.report?.checks ?? [])];
    requireValue(
      evidence.some((p) => p.code === 0 && p.purpose !== 'diagnostic' && sameCommand(check, p)),
      'Reused check must match a recorded passing command',
    );
    requireValue(
      Array.isArray(item.freshCheckIndices),
      'Reused evidence needs fresh check references',
    );
    if (prior.sourceFingerprint !== context.sourceFingerprint)
      requireValue(
        item.freshCheckIndices.length > 0,
        'Changed source needs fresh impact checks before reusing evidence',
      );
    for (const index of item.freshCheckIndices)
      requireValue(
        Number.isInteger(index) &&
          index !== item.checkIndex &&
          report.checks[index]?.repositoryId === check.repositoryId &&
          !reuse.some((r) => r.checkIndex === index),
        'Impact checks must be fresh and cover the same repository',
      );
    reused.add(item.checkIndex);
  }
  if (context.journal)
    for (const [index, check] of report.checks.entries())
      if (!reused.has(index))
        requireValue(
          context.journal.some(
            (record) =>
              record.status === 'complete' &&
              record.purpose !== 'diagnostic' &&
              record.sourceFingerprint === context.sourceFingerprint &&
              sameCommand(record, check),
          ),
          'Fresh check evidence must match a completed supervised check',
        );
  for (const entry of entries) {
    if (entry.repository.verificationMode !== 'commands') continue;
    for (const command of entry.repository.checks)
      requireValue(
        report.checks.some(
          (check) =>
            check.repositoryId === entry.repository.id &&
            check.command === command.command &&
            JSON.stringify(check.args) === JSON.stringify(command.args),
        ),
        'Configured commands remain mandatory in mixed verification workspaces',
      );
  }
  return report;
}
