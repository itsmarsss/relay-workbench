import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verificationSignature(entries) {
  return JSON.stringify(
    entries.map((e) => ({
      id: e.repository.id,
      workspace: e.workspace,
      baseCommit: e.baseCommit,
      instructions: e.repository.instructions,
      checks: e.repository.checks,
      mode: e.repository.verificationMode,
    })),
  );
}
export async function prepareCheckRunner(
  directory,
  taskId,
  attemptId,
  entries,
  sourceFingerprint,
  signature,
  timeout,
) {
  const root = resolve(directory);
  const artifact = join(root, 'artifacts', taskId, attemptId);
  await mkdir(artifact, { recursive: true, mode: 0o700 });
  const spec = {
    attemptId,
    sourceFingerprint,
    signature,
    repositories: entries.map((e) => ({
      id: e.repository.id,
      root: e.workspaceRoot,
      cwd: e.workspace,
      baseCommit: e.baseCommit,
    })),
    lockDirectory: join(root, 'verification-resource.lock'),
    journal: join(artifact, 'checks.jsonl'),
    progressPath: join(artifact, 'check-progress.json'),
    checkTimeoutMs: timeout * 2,
    resourceWaitTimeoutMs: timeout,
  };
  const specPath = join(artifact, 'check-runner.json');
  await writeFile(specPath, JSON.stringify(spec), { mode: 0o600 });
  return {
    executable: process.execPath,
    argsPrefix: [fileURLToPath(new URL('./check-runner.js', import.meta.url)), specPath],
    ...spec,
  };
}
export async function readCheckJournal(runner) {
  if (!runner) return [];
  let content;
  try {
    content = await readFile(runner.journal, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (content.length > 2 * 1024 * 1024) throw Error('Verification journal exceeds its size limit');
  const records = new Map();
  for (const line of content.split('\n')) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    } // A running writer may have a partial final line.
    if (
      row.attemptId !== runner.attemptId ||
      row.sourceFingerprint !== runner.sourceFingerprint ||
      row.signature !== runner.signature ||
      !runner.repositories.some((r) => r.id === row.repositoryId)
    )
      continue;
    if (
      typeof row.id !== 'string' ||
      typeof row.command !== 'string' ||
      !Array.isArray(row.args) ||
      !row.args.every((a) => typeof a === 'string') ||
      typeof row.cwd !== 'string'
    )
      continue;
    records.set(row.id, row);
  }
  return [...records.values()].slice(-200);
}
export function priorVerificationEvidence(task, signature) {
  return task.attempts
    .filter(
      (a) => a.stage === 'verify' && (a.verificationEvidence?.length || a.handoff?.verification),
    )
    .slice(-2)
    .map((a) => ({
      attemptId: a.id,
      sourceFingerprint: a.beforeFingerprint,
      signature: a.verificationSignature,
      reusable: a.verificationSignature === signature,
      report: a.handoff?.verification,
      checks: a.verificationEvidence ?? [],
      sourceSnapshot: a.verificationSourceSnapshot,
    }));
}
