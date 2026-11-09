import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { reliabilityScenarios, runReliabilityScenario } from '../test/reliability/scenarios.js';

const args = process.argv.slice(2);
const options = { repeat: 1 };
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') options.list = true;
    else if (['--scenario', '--repeat', '--report'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error(`Missing value for ${args[i]}`);
      options[args[i].slice(2)] = args[++i];
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  const repeat = Number(options.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)
    throw new Error('--repeat must be between 1 and 100');
  const scenarios = reliabilityScenarios.filter(
    (s) => !options.scenario || s.id === options.scenario,
  );
  if (!scenarios.length) throw new Error(`Unknown scenario: ${options.scenario}`);
  if (options.list)
    for (const scenario of scenarios) console.log(`${scenario.id}: ${scenario.title}`);
  else {
    const results = [];
    for (let iteration = 1; iteration <= repeat; iteration++) {
      for (const scenario of scenarios) {
        const result = await runReliabilityScenario(scenario.id);
        results.push({ iteration, ...result });
        console.log(
          `${result.passed ? 'PASS' : 'FAIL'} ${scenario.id} (${result.durationMs}ms)${result.artifactDirectory ? ` · evidence: ${result.artifactDirectory}` : ''}`,
        );
        if (!result.passed) console.error(result.error);
      }
    }
    if (options.report) {
      const report = resolve(options.report);
      await mkdir(dirname(report), { recursive: true });
      await writeFile(
        report,
        JSON.stringify(
          { finishedAt: new Date().toISOString(), passed: results.every((r) => r.passed), results },
          null,
          2,
        ) + '\n',
      );
      console.log(`Report: ${report}`);
    }
    if (results.some((r) => !r.passed)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
