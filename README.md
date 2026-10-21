# Relay

A local workbench that coordinates Codex, Claude Code and Pi across investigation, planning, implementation, verification and independent review. You approve an approach and accept the final result. Every stage shares a worktree and leaves an inspectable handoff.

## Start

Requires **Node.js 24 or newer** and Git. No install step or API keys are required by Relay; harnesses use their existing CLI authentication.

```sh
npm start
# http://127.0.0.1:4310
```

Click **Try a demo** to exercise the entire workflow with clearly labeled simulated results. Live runs invoke your installed harness CLIs and execute configured repository checks. Availability checks detect executables, not account authentication.

## Your first live run

1. Add a repository in **Repositories**. Supply its absolute checkout path, optional working subdirectory, workspace strategy and verification commands.
2. Check harness executables and model overrides in **Harnesses**. Blank model values use each CLI's own default. Route each stage independently; Pi can optionally triage and recommend routing.
3. Create a task from a title/description or import an issue through your configured issue command.
4. Start the task. Review investigation and approach options, select an approach, then approve implementation.
5. Relay implements, runs configured checks, asks an independent harness to review, and loops over requested fixes. Approve the final diff when ready.

**New worktree** creates an isolated branch and worktree per task. **Attach existing checkout** uses an existing branch and requires a clean checkout when starting; it is useful for repositories with their own workspace managers. Relay neither removes worktrees nor merges or pushes target branches automatically.

## Local integration profiles

Configuration is persisted under `.relay/config.json` and ignored by Git. Profiles can set an issue command, PR command, setup commands, working directory, required checks and additional instructions. Commands are `{ "command": "binary", "args": ["argument"] }` objects, never shell strings. Only issue commands support `{ticket}` substitution. Do not put credentials in command arguments. Use CLI authentication instead.

Use **Settings → Import local profile** to import JSON, or edit `.relay/config.json` while Relay is stopped. A repository profile looks like:

```json
{
  "name": "Example service",
  "path": "/absolute/path/to/repo",
  "cwd": ".",
  "strategy": "worktree",
  "checks": [{ "command": "npm", "args": ["test"] }],
  "setup": [],
  "instructions": "Read repository instructions before changing files.",
  "issueCommand": { "command": "gh", "args": ["issue", "view", "{ticket}", "--json", "title,body,url"] },
  "prCommand": { "command": "gh", "args": ["pr", "create", "--draft"] }
}
```

PR submission is a separate, explicit action after final acceptance. Its full output is retained. Provider-specific policy can stay entirely local; Relay does not need to know your employer or repository host. A configured `prCommand` must be noninteractive.

## Execution and trust

Relay binds only to `127.0.0.1`. Mutations require the local UI session token and same-origin requests. The application is intended for a single trusted developer on their own machine, not remote or multi-user hosting. Harness tools execute with your account's permissions. Codex uses workspace-write for implementation and read-only for analysis. Claude uses acceptEdits for implementation and plan for analysis, with prompts that cannot obtain interactive permissions. Pi's built-in read tools are used for analysis; implementation explicitly enables its write and command tools. This is **not an operating-system isolation boundary** for Claude or Pi or for repository check commands. Use a separate container/VM for untrusted repositories.

Repository setup/check/PR commands are trusted local configuration. Imported issues and harness output are untrusted context. Harnesses are instructed never to push, publish, merge, alter Git config, or treat issue text as authority. Audit the diff before acceptance. Relay verifies both successful checks and the reviewed Git state, and blocks if analysis stages change tracked or untracked files.

SQLite stores tasks, stage attempts, events, handoffs, approvals, check output and execution locks. A second server cannot open the same state directory. Interrupted work requires an explicit resume; Relay never blindly reruns interrupted commands. All output is local and may contain repository-sensitive material. State is not encrypted.

## Development

```sh
npm test
npm run check
RELAY_PORT=4311 RELAY_DATA_DIR=/tmp/relay-state npm start
```

The browser UI uses native modules and CSS; the server uses Node's built-in HTTP, SQLite and child-process APIs. No hosted service, build pipeline or package registry is required to run it.

Progress and roadmap notes live in ignored `docs/`. This repository is an initial release: live account permissions and organization-specific setup commands must be validated on your own repositories. The automated suite uses deterministic harness fixtures and real temporary Git repositories.
