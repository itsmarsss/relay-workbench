import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildInvocation, decodeEvent } from '../server/harness.js';
import { HANDOFF_SCHEMA, DEFAULT_CONFIG, parseHandoff, validateHandoff } from '../server/domain.js';
import { runProcess } from '../server/process.js';

// Explicit, opt-in live protocol probe: contacts your configured harness accounts.
const requested = process.argv.slice(2);
const ids = requested.length ? requested : ['codex', 'claude', 'pi'];
if (ids.some((id) => !['codex', 'claude', 'pi'].includes(id)))
  throw new Error('Use codex, claude, or pi');
const directory = await mkdtemp(join(tmpdir(), 'relay-probe-'));
const resultDirectory = resolve(process.env.RELAY_PROBE_OUTPUT || 'docs/probes');
await mkdir(resultDirectory, { recursive: true });
try {
  await runProcess('git', ['init', directory]);
  const schemaPath = join(directory, 'schema.json');
  await writeFile(schemaPath, JSON.stringify(HANDOFF_SCHEMA));
  const expected = {
    summary: 'Protocol probe passed.',
    details: 'Returned a structured handoff without using tools.',
    files: [],
    evidence: ['Structured response protocol probe only; no development task was executed.'],
    risks: [],
    options: [],
    findings: [],
    verdict: 'complete',
    routing: DEFAULT_CONFIG.routing,
  };
  for (const id of ids) {
    process.stdout.write(`Probing ${id} structured output…\n`);
    const invocation = buildInvocation(id, DEFAULT_CONFIG.harnesses[id], schemaPath, 'investigate');
    let final, error;
    const result = await runProcess(invocation.command, invocation.args, {
      cwd: directory,
      timeout: 180000,
      input: `This is a protocol conformance test, not a coding task. Do not invoke any tools, inspect files, or perform an investigation. Return ONLY the following JSON object, conforming to this schema.\nObject: ${JSON.stringify(expected)}\nSchema: ${JSON.stringify(HANDOFF_SCHEMA)}`,
      onLine(line, stream) {
        if (stream !== 'stdout') return;
        const decoded = decodeEvent(id, line);
        if (decoded.final !== undefined) final = decoded.final;
        if (decoded.error) error = decoded.error;
      },
    });
    await writeFile(
      join(resultDirectory, `${id}.json`),
      JSON.stringify({ ...result, final, error }, null, 2),
      { mode: 0o600 },
    );
    if (result.code !== 0 || error) {
      process.stderr.write(
        `${id}: FAILED (${error || result.stderr.slice(-1200) || result.code})\n`,
      );
      process.exitCode = 1;
      continue;
    }
    try {
      validateHandoff(parseHandoff(final), 'investigate');
      process.stdout.write(`${id}: structured output passed\n`);
    } catch (error) {
      process.stderr.write(`${id}: FAILED (${error.message})\n`);
      process.exitCode = 1;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
