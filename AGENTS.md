# Relay

Standalone, local-first development orchestrator. Requires Node 24+; no runtime dependencies.

- Run `pnpm test` and `pnpm run check` before merging a feature.
- Use feature branches and semantic commit subjects shorter than 60 characters.
- Never credit an AI agent: no Co-Authored-By or other attribution trailers in commits, and no "Generated with" lines in commits or pull requests.
- Keep personal paths, organization policies, private hosts and integration profiles out of tracked files.
- Local profiles and runtime state belong in `.relay/`; progress and roadmap belong in ignored `docs/`.
- Never execute ticket text as a shell command. Spawn commands with explicit argument arrays.
- Keep human approval before implementation and final acceptance.
- A repository can have only one active writer. Never silently discard dirty files.
- A failed check or incomplete structured handoff must block progression.
- Test transitions, failure recovery, process cancellation, validation and HTTP boundaries.
