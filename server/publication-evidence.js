// A rebase changes the base SHA, not the identity of every previous check.
export function publicationEvidence(task, signature) {
  const runs = [...(task.attempts ?? []), ...(task.deliveryRuns ?? [])];
  return runs
    .filter(
      (run) =>
        run.stage === 'verify' &&
        (run.verificationEvidence?.length || run.verificationReport || run.handoff?.verification),
    )
    .slice(-6)
    .map((run) => ({
      attemptId: run.id,
      sourceFingerprint: run.beforeFingerprint ?? run.verificationRunner?.sourceFingerprint,
      signature: run.verificationSignature ?? run.verificationRunner?.signature,
      reusable: compatible(
        run.verificationSignature ?? run.verificationRunner?.signature,
        signature,
      ),
      report: run.verificationReport ?? run.handoff?.verification,
      checks: run.verificationEvidence ?? [],
      sourceSnapshot: run.verificationSourceSnapshot,
    }));
}
function compatible(previous, current) {
  try {
    const normalize = (value) => JSON.parse(value).map(({ baseCommit, ...entry }) => entry);
    return JSON.stringify(normalize(previous)) === JSON.stringify(normalize(current));
  } catch {
    return false;
  }
}
export const PUBLICATION_CHECK_SCOPE =
  'This is publication impact validation, not a new implementation verification campaign. The human already accepted the implementation. Compare the original accepted source snapshot and prepared diff first. Reuse eligible passing evidence with an explicit impact explanation and targeted fresh checks for the actual conflict resolutions, changed callers, generated artifacts or regressions. A changed base SHA alone does not require rerunning every suite. Do not run whole-repository coverage or unrelated integration suites merely to publish. The current user explicitly wants scoped publication checks rather than repeating blanket full-suite requirements after a rebase; document those requirements and the scoped evidence satisfying the affected behavior. Do not repair unrelated upstream failures or investigate shared-service instability indefinitely. Failed relevant checks need repair; unrelated failures should be documented with concrete evidence and excluded from publication requirements, never reported as passing. Run only checks necessary to establish the approved behavior remains valid. Return the findings promptly; the publication writer handles actionable fixes.';
