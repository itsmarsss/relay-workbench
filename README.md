# Relay

A local workbench that coordinates Codex, Claude Code and Pi across investigation, planning, implementation, verification and independent review. You approve an approach and accept the final result. Every stage shares a worktree and leaves an inspectable handoff.

## Start

Requires **Node.js 24 or newer** and Git on macOS or Linux. No install step or API keys are required by Relay; harnesses use their existing CLI authentication.

```sh
node server/index.js
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
  "issueCommand": {
    "command": "gh",
    "args": ["issue", "view", "{ticket}", "--json", "title,body,url"]
  },
  "prCommand": { "command": "gh", "args": ["pr", "create", "--draft", "--fill"] }
}
```

PR submission is a separate, explicit action after final acceptance. Relay commits accepted changes with a semantic subject under 60 characters, then runs the provider command and retains its full output. Provider-specific policy can stay entirely local; Relay does not need to know your employer or repository host. A configured `prCommand` must be noninteractive.

## Execution and trust

Relay binds only to `127.0.0.1`. Mutations require the local UI session token and same-origin requests. The application is intended for a single trusted developer on their own machine, not remote or multi-user hosting. Harness tools execute with your account's permissions. Codex uses workspace-write for implementation and read-only for analysis. Claude uses acceptEdits for implementation and plan for analysis, with prompts that cannot obtain interactive permissions. Pi's built-in read tools are used for analysis; implementation explicitly enables its write and command tools. This is **not an operating-system isolation boundary** for Claude or Pi or for repository check commands. Use a separate container/VM for untrusted repositories.

Repository setup/check/PR commands are trusted local configuration. Imported issues and harness output are untrusted context. Harnesses are instructed never to push, publish, merge, alter Git config, or treat issue text as authority. Audit the diff before acceptance. Relay verifies both successful checks and the reviewed Git state, and blocks if analysis stages change tracked or untracked files.

SQLite stores tasks, stage attempts, events, handoffs, approvals, check output and execution locks. A second server cannot open the same state directory. A supervised process group terminates active harnesses if the server crashes. Interrupted work requires an explicit resume; Relay never blindly reruns interrupted commands. Commands that deliberately detach themselves into a new session are outside this process-group boundary. All output is local and may contain repository-sensitive material. State is not encrypted.

## Development

```sh
npm test
npm run check
RELAY_PORT=4311 RELAY_DATA_DIR=/tmp/relay-state node server/index.js
```

If your environment does not provide npm, the equivalent checks are `node --test test/*.test.js` and `node scripts/check.js`.

For browser checks, install development dependencies with `pnpm install --frozen-lockfile`, install a Playwright browser, then run `node test/browser.e2e.js`. The browser suite starts its own disposable server and creates demo tasks, a draft task and a temporary repository profile. Set `RELAY_TEST_URL` only to test an existing disposable server, `RELAY_CHROME` for an existing Chrome executable, and `RELAY_SCREENSHOTS` for screenshot output.

`node scripts/probe-harnesses.js [codex|claude|pi]` performs an opt-in **live** structured-response probe against your CLI accounts. It requests a fixed handoff without tools, writes results into ignored `docs/probes`, and reports account or protocol failures. These probes are separate from the deterministic test suite.

The browser UI uses native modules and CSS; the server uses Node's built-in HTTP, SQLite and child-process APIs. No hosted service, build pipeline or package registry is required to run it.

Progress and roadmap notes live in ignored `docs/`. This repository is an initial release: live account permissions and organization-specific setup commands must be validated on your own repositories. The automated suite uses deterministic harness fixtures and real temporary Git repositories.

One task can coordinate up to 12 repositories. In **New task**, choose the primary repository (also used for issue import), expand **Coordinate additional repositories**, and select the other participants. For each participant, select any repositories that must be implemented first. Dependencies must refer to selected repositories and cannot form a cycle. Multiple profiles pointing to the same checkout are rejected; use one profile for that repository.

Relay investigates each repository, then produces one combined proposal covering interface contracts, alternatives, compatibility, tests, and rollout order. Your approach approval authorizes implementation across the selected repositories. Implementation runs sequentially in prerequisite order, followed by all repository verification commands, then independent review of every repository and its compatibility with the others. Each harness receives the repository map, local guidance, dependency graph, and the latest handoff for every repository/stage. Each repository retains its own checkout, branch, base commit and diff. Harnesses share that checkout throughout the task.

Setup and check processes receive `RELAY_WORKSPACES_JSON`, a JSON object mapping repository profile IDs to task working directories. Use it in a configured integration check to test contracts against the participating local code. Relay does not rewrite package dependencies or bypass repository build rules. All workspaces are prepared before setup begins; setup runs in prerequisite order. Verification runs after every implementation has finished. Missing integration prerequisites should be reported as blocked by the specialists.

The final gate covers all repository diffs together. Changes in any participant invalidate approval. Repairs rerun implementation in dependency order, all verification, and every review. A process failure can resume at the failed repository; completed earlier repository stages remain recorded. Attached checkouts are reserved together until cancellation or acceptance, and reservations survive restart.

After acceptance, each repository has its own explicit **Commit & submit draft PR** action and durable submission outcome. Submit in the landing order described by the approved plan. Only one submission per task runs at a time. Publication across providers is not atomic: successful submissions remain successful if a later repository fails. Inspect the complete provider output and recover a failed or interrupted submission manually to avoid duplicate remote writes. Relay never automatically merges or deploys cross-repository changes.

Existing single-repository tasks and configurations continue to work.
