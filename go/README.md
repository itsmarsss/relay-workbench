# Experimental Go backend

This is an isolated migration preview, not a replacement for Relay. It can run investigation, planning, human approach approval, implementation, agent-selected supervised checks, independent review, and human final acceptance. A specialist's structured blocker can trigger a bounded debugger and targeted continuation; timed-out checks do not automatically trigger a debugger. Debugger and continuation runs use fresh sessions with recorded context, not native session resumption. Failed checks and review findings route back to implementation within a configured repair limit. Publishing, PR monitoring, checkpoints, and interactive terminals are not connected yet. Use separate test repositories: this preview cannot coordinate writers with the original Relay. Do not use it with real Relay state.

It requires Go 1.22 or newer, a C toolchain, `pkg-config`, and SQLite development headers and libraries. To build and test, run `go test -race ./...` and `go vet ./...` inside this directory. The existing JavaScript backend and its tests remain authoritative during migration.

For an isolated local preview, build the experimental React frontend, then run:

```sh
go run ./cmd/relay-go --data-dir /path/to/new/empty-directory --web-dir /path/to/relay/web/dist --port 4311
```

The state directory must be empty on first use. A marker prevents opening an unmarked existing directory, and the exclusive `server.lock` prevents two servers from writing concurrently. On macOS and Linux, a guarded recovery step removes a lock only when its owner is confirmed gone; ambiguous or live owners require inspection. Copying or importing live state is not implemented. The listener binds to IPv4 loopback; configuration, draft creation and workflow controls require the session token. Setup interrupted during execution is preserved and cannot be resumed automatically. Attached checkouts and simulated workflow execution are not supported. No migration, workflow, security, terminal, or performance parity is claimed.

Configured issue import commands receive one literal `{ticket}` argument. GitHub CLI issue imports retrieve paginated discussion; other providers may return comments in their JSON. Incomplete discussions and descriptions exceeding the task limit are rejected rather than truncated.

## Storage safeguards

The experimental Storage page reports free space on the Relay data volume, supports additional explicitly selected paths, and performs bounded read-only directory scans. Warning and critical thresholds are configurable. Workspace preparation and guarded runs check free space before new work, returning a distinct storage-pressure error; they never stop an already running process or send disk pressure to a debugger. Automatic cleanup is not implemented, and external paths are never deleted by these helpers.
