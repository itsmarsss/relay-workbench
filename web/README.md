# Experimental React frontend

This is an isolated migration preview. It supports repository profiles and task drafts, but task execution controls, approvals, code review and interactive terminals have not been ported. Keep using the existing Relay for active work.

Install dependencies with `npm ci`, then run `npm run check`, `npm test`, and `npm run build`. Serve `dist` with the experimental Go backend only against its isolated state directory. The lockfile includes esbuild binaries for supported platforms. A clean `npm ci` and browser testing still require verification with registry and local socket access.

Storage displays free space, configurable thresholds and read-only scans of selected paths. Automatic cleanup and scheduler-wide admission are not available yet.
