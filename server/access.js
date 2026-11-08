// Relay runs every workflow agent as the current OS user, without a harness sandbox.
// This is application policy, never authority supplied by ticket content.
export function developmentAccess() {
  return { elevated: true, writable: true, networkAccess: true, writableRoots: [] };
}
