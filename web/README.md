# Experimental React frontend

This is an isolated migration preview. It supports repository profiles, task drafts, development through final acceptance, bounded debugger recovery, blocker decisions, and read-only change previews on separate test repositories. Publishing, checkpoints, native session continuation, and interactive terminals are not yet connected. Keep using the existing Relay for active work; the two instances cannot coordinate writers.

Drafts can import issue context through a repository's configured issue command. Existing draft text is preserved, and missing discussion is reported.

Install dependencies with `npm ci`, then run `npm run check`, `npm test`, and `npm run build`. `npm run test:e2e` builds and runs an isolated Go server and disposable Git fixture with Playwright; install its Chromium browser or set `RELAY_CHROME` to an existing compatible browser. Serve `dist` with the experimental Go backend only against its isolated state directory.

Storage displays free space, configurable thresholds and read-only scans of selected paths. Automatic cleanup and scheduler-wide admission are not available yet.
