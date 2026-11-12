# Relay Go backend

The rewrite pairs this Go service with the React/TypeScript frontend in `../web`. It runs independently from the legacy Node service, with its own state directory and port. Keep the legacy service running while evaluating the rewrite. Do not point both services at the same state or active repository.

Requires Go 1.22+, a C compiler, `pkg-config`, SQLite development headers/libraries, Git and macOS or Linux. Provider CLIs use their existing authentication. tmux enables live agent terminals and browser takeover. The server itself does not require Node; frontend builds and Pi's JavaScript CLI do.

## Build and run

```sh
pnpm install --frozen-lockfile
pnpm --dir web run build
cd go
go build -o ../.relay/bin/relay-go ./cmd/relay-go
cd ..
.relay/bin/relay-go --data-dir .relay/rewrite-state --web-dir web/dist --port 4311
```

The first state directory must be absent or empty. Thereafter its marker and exclusive process lock identify it as Go-owned state. The listener binds to `127.0.0.1`. Configuration and mutations require the browser session token. Stop with SIGTERM or Ctrl+C; subprocesses are cancelled and interrupted work remains available for explicit resume.

## Implemented surfaces

- Repository discovery/profiles, ordinary Git worktrees, configured workspace managers, explicitly attached clean checkouts, cross-repository dependencies and full issue context.
- Routing, investigation, planning, human approach approval, implementation, supervised agent-selected checks, independent review, final human acceptance, bounded repair/debugger recovery and deliberate Auto delegation.
- Agent publication/rebase, pull request state, read-only monitoring, deduplicated feedback repairs, post-acceptance follow-ups, editable provider/model/effort and browser terminal takeover.
- Persistent workspace and task chats, streamed text/tools, task mentions, source/Git/GitHub reads, approved memory, task/settings/storage proposals and exact human approval.
- Git checkpoints, staged/unstaged/untracked restoration into fresh continuation worktrees, alternate saved approach/debugger decisions, execution branches and history.
- React board/list, task deck with tabs/splits, rich Markdown/images, inline revision-bound diff comments, activity pagination, inbox, settings, themes, low motion and searchable controls.
- Live elapsed/progress indicators, observational routing evidence, opt-in desktop decision notifications, structured repository command editors and multi-repository delivery summaries.

A task's board override only changes its displayed column. It never grants implementation or final acceptance. Auto mode is a recorded, task-scoped human delegation. Failed checks, missing structured handoffs, unresolved reviews and modified accepted source block progression.

Editing prepared task requirements revokes the selected approach and Auto delegation and returns the task to planning. Repository scope stays fixed after any workspace preparation; use a continuation for another scope. Long activity histories use bounded windows: loading earlier events pauses live appends until **Jump to latest**.

One Go writer at a time reserves a shared Git repository across linked worktrees and Go processes. The legacy Node server does not participate in that lock protocol. Use separate fixture repositories while both versions run.

## Storage

Warning and critical limits apply to state, workspace and explicitly monitored volumes. Critical pressure blocks new work; it does not kill a running agent or invoke a debugger. Checkpoints store incremental Git objects rather than directory copies. The latest 100 snapshots and snapshots referenced by continuations are retained; Git's normal object maintenance controls eventual collection of unreferenced objects.

An accepted, published task offers **Clean up workspace**. It removes only this instance's clean ordinary worktrees, preserving branches, pull requests and checkpoints. Dirty files block removal. Ignored files require a separate explicit choice. Attached checkouts, external managed workspaces and shared build caches are excluded. Reopen work through a checkpoint continuation. Cleanup is explicit, not an unattended global deletion policy.

## Export and migration

Settings can download a bounded `.tar.gz` snapshot while this instance runs. It includes database records, configuration and image attachments with SHA-256 checksums. It excludes worktrees, caches, build output and process capabilities. Exported configuration can contain private repository paths and commands; keep archives private.

For a stopped Go instance:

```sh
.relay/bin/relay-go --data-dir .relay/rewrite-state --export-state /path/to/new-backup.tar.gz
.relay/bin/relay-go --import-state /path/to/new-backup.tar.gz --data-dir /path/to/absent-state
```

Legacy migration reads only a stopped, checkpointed source or an offline copy. It refuses the legacy server lock and nonempty SQLite WAL. It never creates a marker, lock or SHM file in the legacy source:

```sh
.relay/bin/relay-go --export-legacy /path/to/offline-legacy-state --export-state /path/to/new-backup.tar.gz
```

Imports validate inventory, sizes, checksums, record structure and paths before atomically installing into an absent directory. Existing destinations cannot be overwritten, including by concurrent import attempts. The expanded archive is capped at 512 MiB and 5,000 attachments. Imports retain tasks, activity, conversations and checkpoint descriptions as **read-only history**. They remove workspace authority, approvals, Auto delegation and process capabilities; providers and imported memory are disabled. Review configuration, enable providers, then choose **Create fresh draft** on an imported task. This deliberately avoids adopting another instance's live worktrees or stale test evidence. Imported checkpoint descriptions do not include the original repository's Git objects and cannot restore source.

## Validation

```sh
cd go
go test -race -p 2 ./...
go vet ./...
cd ../web
pnpm run check
pnpm test
pnpm run test:e2e
pnpm run test:workspace
```

Browser tests use disposable state and repositories. Install Playwright Chromium or set `RELAY_CHROME` to a compatible browser executable. The legacy `pnpm test` and `pnpm run check` remain available from the repository root.

## Operational limits

Continuations and debugger runs use fresh provider sessions with retained workspace/context, rather than resuming native sessions. Supervision cancels process groups and private tmux sessions; it is not an OS sandbox. A descendant that deliberately detaches can escape ordinary process-group cancellation. Source reads can overlap a running worker and include revision evidence; they are not atomic filesystem snapshots.

Claude and Codex workspace-chat adapters have been smoke-tested with real installed CLIs. Pi's restricted tool adapter has protocol tests, but needs a launcher that allows disabling bundled tools/extensions. A managed launcher that refuses those flags returns an actionable error; Relay does not bypass its policy or silently grant extra tools. Model availability, authentication and permissions still depend on each installed provider.
