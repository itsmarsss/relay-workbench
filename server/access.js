export function developmentAccess(task, stage) {
  // Only the engine creates this diagnostic context; ticket text cannot grant access.
  if (
    (stage === 'investigate' && task.debugContext?.executionAccess === 'host') ||
    (stage === 'verify' && task.verificationContext?.executionAccess === 'host')
  )
    return { elevated: true, writable: true, networkAccess: true, writableRoots: [] };
  if (stage === 'monitor')
    return { elevated: true, writable: true, networkAccess: true, writableRoots: [] };
  const configured = task.repository?.developmentAccess ?? {};
  return {
    writable: stage === 'implement' || (stage !== 'triage' && configured.analysisCommands === true),
    networkAccess: configured.networkAccess === true,
    writableRoots: configured.writableRoots ?? [],
  };
}
