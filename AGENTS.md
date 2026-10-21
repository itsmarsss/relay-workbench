# Relay

Standalone, local-first development orchestrator. Requires Node 24+; no runtime dependencies.

- Run `npm test` and `npm run check` before merging a feature.
- Use feature branches and semantic commit subjects shorter than 60 characters.
- Do not add attribution trailers to commits.
- Keep personal paths, organization policies, private hosts and integration profiles out of tracked files.
- Local profiles and runtime state belong in `.relay/`; progress and roadmap belong in ignored `docs/`.
- Never execute ticket text as a shell command. Spawn commands with explicit argument arrays.
- Keep human approval before implementation and final acceptance.
- A repository can have only one active writer. Never silently discard dirty files.
- A failed check or incomplete structured handoff must block progression.
- Test transitions, failure recovery, process cancellation, validation and HTTP boundaries.
