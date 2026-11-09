# Experimental Go backend

This is an isolated migration preview, not a replacement for Relay. It can create isolated workspaces and run real agents through investigation and planning, with start, pause and resume controls. Human approach approval, implementation scheduling, verification, publishing, PR monitoring, and interactive terminals are not connected yet. Use separate test repositories: this preview cannot coordinate writers with the original Relay. Do not use it with real Relay state.

It requires Go 1.22 or newer, a C toolchain, `pkg-config`, and SQLite development headers and libraries. To build and test, run `go test -race ./...` and `go vet ./...` inside this directory. The existing JavaScript backend and its tests remain authoritative during migration.

For an isolated local preview, build the experimental React frontend, then run:

```sh
go run ./cmd/relay-go --data-dir /path/to/new/empty-directory --web-dir /path/to/relay/web/dist --port 4311
```

The state directory must be empty on first use. A marker prevents opening an unmarked existing directory, and the exclusive `server.lock` prevents two servers from writing concurrently. Copying or importing live state is not implemented. The listener binds to IPv4 loopback; configuration, draft creation and workflow controls require the session token. Setup interrupted during execution is preserved and cannot be resumed automatically. Attached checkouts and simulated workflow execution are not supported. No migration, workflow, security, terminal, or performance parity is claimed.

## Storage safeguards

The experimental Storage page reports free space on the Relay data volume, supports additional explicitly selected paths, and performs bounded read-only directory scans. Warning and critical thresholds are configurable. Workspace preparation and guarded runs check free space before new work, returning a distinct storage-pressure error; they never stop an already running process or send disk pressure to a debugger. Automatic cleanup is not implemented, and external paths are never deleted by these helpers.
