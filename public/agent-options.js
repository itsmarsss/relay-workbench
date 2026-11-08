// Harness-level options; individual models may support fewer effort levels.
export const effortLevels = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};
export function effortArgs(provider, effort) {
  if (!effort) return [];
  if (provider === 'codex') return ['--config', `model_reasoning_effort="${effort}"`];
  return [provider === 'pi' ? '--thinking' : '--effort', effort];
}
