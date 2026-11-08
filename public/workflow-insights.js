import { taskRuns } from './task-runs.js';
export const workflowPresets = [
  {
    id: 'bugfix',
    title: 'Bug fix',
    description: 'Reproduce, repair, and test the affected behavior.',
    guidance:
      'Reproduce the reported behavior and add a focused regression check. Prefer the smallest complete repair; verify touched surfaces and required repository checks.',
  },
  {
    id: 'small',
    title: 'Small change',
    description: 'A focused change with a concise proposal.',
    guidance:
      'Keep investigation and planning proportional to a small change. Propose one recommended approach and only meaningful alternatives. Avoid unrelated refactors or repeated broad verification.',
  },
  {
    id: 'investigate',
    title: 'Investigate only',
    description: 'Gather evidence and stop with findings. No implementation.',
    guidance:
      'Investigate and report the reproduction, likely cause, relevant files, evidence, remaining uncertainty and recommended next steps. Do not modify source.',
  },
  {
    id: 'cross-repo',
    title: 'Cross-repo feature',
    description: 'One plan covering contracts and repository dependencies.',
    guidance:
      'Plan all repositories together, including interface contracts, compatibility, implementation prerequisites, landing order, rollout and rollback. Verify each touched surface and cross-repository interactions.',
  },
];
export function workflowHealth(task) {
  const runs = taskRuns(task);
  const failures = runs.filter(
    (r) =>
      r.status === 'failed' ||
      r.handoff?.verdict === 'blocked' ||
      r.handoff?.verdict === 'changes_requested',
  );
  const active = runs.findLast((r) => r.status === 'running');
  const recovered = task.status === 'completed' || task.status === 'awaiting_final';
  return {
    state:
      task.loopGuard?.stopped && !recovered
        ? 'attention'
        : task.recovery?.active
          ? 'recovering'
          : failures.length && !recovered
            ? 'watching'
            : 'healthy',
    failures: failures.length,
    debugging: runs.filter((r) => r.role === 'debug').length,
    rounds: task.round ?? 0,
    repeated: task.loopGuard?.count ?? 0,
    summary:
      task.loopGuard?.stopped && !recovered
        ? 'Repeated failure without workspace progress; automation paused.'
        : task.recovery?.active
          ? 'Trying a different diagnostic strategy.'
          : active
            ? 'Agent working; execution is bounded.'
            : recovered
              ? 'Required workflow gates completed.'
              : 'No active recovery loop.',
    recovered,
    strategy: recovered ? '' : (task.loopGuard?.guidance ?? ''),
    evidence: failures.slice(-3).map((r) => ({
      id: r.id,
      stage: r.stage,
      role: r.role,
      summary: r.handoff?.summary || r.error || 'Run failed',
      evidence: r.handoff?.evidence ?? [],
    })),
  };
}
export function decisionBrief(task) {
  const runs = taskRuns(task);
  const last = runs.findLast((r) => r.handoff)?.handoff;
  const decision = task.blockerDecision;
  const plan = runs.findLast((r) => r.stage === 'plan' && r.handoff)?.handoff;
  const options =
    task.status === 'awaiting_plan' ? (plan?.options ?? []) : (decision?.options ?? []);
  return {
    summary: decision?.summary || task.error || last?.summary || 'Review the recorded result.',
    recommendation:
      task.status === 'awaiting_plan' && options[0]
        ? options[0].title
        : task.status === 'awaiting_final'
          ? 'Inspect the diff and verification evidence, then accept or request changes.'
          : decision?.kind === 'runtime_budget'
            ? 'Continue the current stage with a fresh bounded time budget; no test failure was established.'
            : decision?.required?.[0] ||
              decision?.explanation ||
              'Inspect the latest evidence before choosing a direction.',
    tried: runs
      .filter(
        (r) => r.role === 'debug' || r.status === 'failed' || r.handoff?.verdict === 'blocked',
      )
      .slice(-3)
      .map((r) => r.handoff?.summary || r.error || 'Diagnosis attempted'),
    evidence: [...(decision?.evidence ?? last?.evidence ?? [])].slice(-8),
    options,
    decisionId: decision?.id,
    kind: decision?.kind,
    required: decision?.required ?? [],
  };
}
export function completionBrief(task) {
  const runs = taskRuns(task);
  const cycle = task.followUpContext?.startedAt;
  const current = runs.filter(
    (r) =>
      !r.auxiliary &&
      !['publish', 'monitor', 'feedback'].includes(r.stage) &&
      (!cycle || r.startedAt >= cycle),
  );
  const review = current.findLast((r) => r.stage === 'review' && r.handoff);
  const result =
    current.findLast((r) => r.stage === 'implement' && r.handoff)?.handoff ??
    review?.handoff ??
    current.findLast((r) => r.handoff)?.handoff;
  const latestChecks = new Map();
  for (const run of current)
    if (run.stage === 'verify' && run.handoff?.checks)
      latestChecks.set(run.repositoryId ?? 'all', run);
  const checks = [...latestChecks.values()].flatMap((r) =>
    (r.handoff?.checks ?? []).map((c) => ({ ...c, runId: r.id, repositoryId: r.repositoryId })),
  );
  return {
    summary: result?.summary ?? 'No completed result yet.',
    checks,
    risks: [
      ...new Set(
        [...latestChecks.values(), ...(review ? [review] : [])].flatMap(
          (r) => r.handoff?.risks ?? [],
        ),
      ),
    ],
    evidence: result?.evidence ?? [],
    decisions: task.approvals ?? [],
    verified: !!task.verifiedFingerprint,
    reviewed: !!task.reviewedFingerprint,
    investigationOnly: task.preset === 'investigate',
  };
}
export function repositoryCoordination(task) {
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  return entries.map((entry) => {
    const prerequisites = (task.dependencies ?? [])
      .filter((e) => e.repositoryId === entry.repository.id)
      .map((edge) => entries.find((e) => e.repository.id === edge.dependsOn))
      .filter(Boolean);
    const waiting = prerequisites.filter((e) => e.publication?.state !== 'merged');
    return {
      id: entry.repository.id,
      name: entry.repository.name,
      prerequisites: prerequisites.map((e) => e.repository.name),
      waiting: waiting.map((e) => e.repository.name),
      publication: entry.publication,
      implemented:
        task.attempts?.some(
          (r) =>
            r.stage === 'implement' &&
            r.status === 'complete' &&
            r.handoff?.verdict === 'complete' &&
            (!r.repositoryId || r.repositoryId === entry.repository.id),
        ) ?? false,
    };
  });
}
