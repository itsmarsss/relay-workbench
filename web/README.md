# Experimental React frontend

This is an isolated migration preview. It supports repository profiles, task drafts, development through final acceptance, and read-only change previews on separate test repositories. Publishing, automatic debugger recovery, checkpoints, and interactive terminals are not yet connected. Keep using the existing Relay for active work; the two instances cannot coordinate writers.

Install dependencies with `npm ci`, then run `npm run check`, `npm test`, and `npm run build`. `npm run test:e2e` builds and runs an isolated Go server and disposable Git fixture with Playwright; install its Chromium browser or set `RELAY_CHROME` to an existing compatible browser. Serve `dist` with the experimental Go backend only against its isolated state directory.

Storage displays free space, configurable thresholds and read-only scans of selected paths. Automatic cleanup and scheduler-wide admission are not available yet.
