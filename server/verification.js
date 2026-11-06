import { requireValue } from './domain.js';

// This validates agent-reported evidence, never executes text from a handoff.
export function validateVerification(handoff, entries, toolEvidence) {
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
    requireValue(
      check.code === 0,
      `A failed verification check cannot pass the gate: ${check.command} exited ${check.code}`,
    );
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
