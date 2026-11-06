export function developmentAccess(task, stage) {
  const configured = task.repository?.developmentAccess ?? {};
  return {
    writable: stage === 'implement' || (stage !== 'triage' && configured.analysisCommands === true),
    networkAccess: configured.networkAccess === true,
    writableRoots: configured.writableRoots ?? [],
  };
}
