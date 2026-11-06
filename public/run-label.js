import { stageNames } from './ui.js';
export function isVerificationAgent(attempt) {
  return attempt?.role === 'verifier' && ['codex', 'claude', 'pi'].includes(attempt.harness);
}
export function runLabel(attempt) {
  if (attempt.role === 'debug') return 'Debugger';
  if (attempt.role === 'verifier' || attempt.harness === 'checks')
    return isVerificationAgent(attempt) ? 'Verification agent' : 'Configured checks';
  return stageNames[attempt.stage] ?? attempt.stage ?? 'Run';
}
