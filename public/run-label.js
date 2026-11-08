import { stageNames } from './ui.js';
export function isVerificationAgent(attempt) {
  return attempt?.role === 'verifier' && ['codex', 'claude', 'pi'].includes(attempt.harness);
}
export function runLabel(attempt) {
  if (attempt.auxiliary && attempt.stage === 'verify') return 'Publish · verification';
  if (attempt.auxiliary && attempt.stage === 'review') return 'Publish · review';
  if (attempt.role === 'debug') return 'Debugger';
  if (attempt.role === 'verifier' || attempt.harness === 'checks')
    return isVerificationAgent(attempt) ? 'Verification agent' : 'Configured checks';
  if (attempt.stage === 'publish') return 'Publish';
  if (attempt.stage === 'monitor') return 'PR monitoring';
  return stageNames[attempt.stage] ?? attempt.stage ?? 'Run';
}
