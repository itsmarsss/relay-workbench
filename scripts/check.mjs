// Repository checks: Go formatting and vet, the web type check, and Prettier.
import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout || '';
}

const unformatted = run('gofmt', ['-l', '.'], { cwd: 'go', capture: true }).trim();
if (unformatted) {
  console.error('Go files need gofmt:\n' + unformatted);
  process.exit(1);
}
run('go', ['vet', './...'], { cwd: 'go' });
run('pnpm', ['--dir', 'web', 'run', 'check']);
run('pnpm', ['exec', 'prettier', '--check', 'web/src', 'web/scripts', 'scripts', 'README.md']);
console.log('Checks passed.');
