# Relay

Relay is a local, single-user workbench for running coding agents (Claude Code, Codex and Pi)
through a staged workflow, with a person approving the plan and accepting the result.

A task moves through investigation, planning, implementation, verification and independent
review. Each stage runs in the task's own Git worktree and leaves a structured handoff for the
next. You choose an approach before any code is written and accept the final result; failed
checks, missing handoffs and unresolved review findings stop the workflow instead of slipping
through.

Relay runs on your machine, binds to `127.0.0.1`, and uses the agents' existing CLI logins. It
has no accounts and no hosted service.

## What it does

- **Board, list and task deck.** Track tasks by stage, open several side by side, and see live
  progress, activity, logs, changes and the execution graph for each.
- **Approval gates.** Approve an approach, review the diff with inline comments, and accept the
  final result. A blocked stage shows its explanation and options and waits for your decision.
- **Agents with your own logins.** Route each stage to Claude Code, Codex or Pi, and pick the model
  and effort per task.
- **Terminals.** Watch an agent's terminal live, open your own agent or shell in a task's worktree
  (briefed on the task, without pausing its workflow), or take full manual control.
- **Pull requests.** Publish a draft PR, monitor checks and reviews, follow up on feedback, and
  update a branch with its mainline (clean merges push straight away; conflict resolutions wait
  for you).
- **Ask Relay.** Read-only chats about your tasks and their worktrees, with proposals you approve.
- **Checkpoints and storage.** Save and restore work, continue from earlier decisions, see disk
  use per task, and clean up finished worktrees.

## Requirements

- macOS or Linux
- Go 1.22 or newer, a C compiler, `pkg-config` and SQLite development headers
- Node.js 24 or newer and pnpm (for building the frontend)
- Git
- At least one agent CLI, already logged in: Claude Code, Codex or Pi
- tmux (optional; enables live terminals)

## Run it

```sh
pnpm install --frozen-lockfile
pnpm --dir web run build
(cd go && go build -o ../.relay/bin/relay-go ./cmd/relay-go)
.relay/bin/relay-go --data-dir .relay/state --web-dir web/dist --port 4310
```

Open <http://127.0.0.1:4310>. The state directory must be new or empty the first time; after
that it belongs to this instance, and a second Relay cannot open it. Stop Relay with Ctrl+C or
SIGTERM: running agents are stopped and interrupted work waits for you to resume it.

Relay hands its own environment to every agent and terminal it starts, so launch it from the
shell you normally work in. Local profiles, scripts and state belong in `.relay/`, which Git
ignores.

## How it works

```text
go/      Go service: workflow engine, agent harnesses, worktrees, storage, HTTP API
web/     React and TypeScript frontend, served by the Go service from web/dist
server/  The original Node.js service, kept for reference (see server/README.md)
test/    Tests for the Node service and shared behaviour
```

State lives in SQLite under the data directory. Each task gets its own Git worktree and branch.
One writer at a time holds a shared repository, so two agents never edit the same checkout.

## Trust model

Relay is for one developer on their own machine. Agents run as your OS user with your filesystem
and network access; Relay is not a sandbox. What it does enforce: isolated worktrees, a single
writer per repository, approval gates, workspace fingerprints that catch unreviewed changes, and
supervised check evidence. Ticket and issue text is treated as context, never as instructions or
commands. Agents are told never to merge; only the publication agent pushes, and Relay itself
pushes only when you update a branch (never with force). Review the diff before you accept it.

## Development

```sh
(cd go && gofmt -l . && go vet ./... && go test ./...)
(cd web && pnpm run check && pnpm test)
(cd web && pnpm run test:e2e && pnpm run test:workspace && pnpm run test:ui)
pnpm test && pnpm run check   # the Node service and shared tests
```

The browser suites use disposable state and repositories; install Playwright's Chromium or set
`RELAY_CHROME` to a Chrome or Chromium executable. More detail on the Go service, storage, export
and import is in [go/README.md](go/README.md). Contribution rules are in [AGENTS.md](AGENTS.md).
