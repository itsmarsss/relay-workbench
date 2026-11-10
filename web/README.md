# Relay React/TypeScript frontend

The React frontend is served by the standalone [Go backend](../go/README.md). Its API calls do not depend on the legacy JavaScript backend. Keep the two versions on separate ports, state directories and repositories while evaluating the rewrite.

```sh
npm ci
npm run check
npm test
npm run build
```

The Go service serves `dist`. Build tooling requires Node 24+. The browser uses React, TypeScript, Motion, xterm and pinned Markdown sanitization. Tabs/filters and side-chat visibility have URL state; task deck layouts, appearance and motion preferences persist in the browser. Workspace conversations and task side chats persist on the server.

`npm run test:e2e` exercises the workflow through approvals, repairs, debugger decisions, review, continuations, Auto and interactive terminal takeover. `npm run test:workspace` covers chats, mentions, proposals, settings, board controls, demos and navigation. `npm run test:ui` audits desktop, tablet and phone layouts in both themes, including axe accessibility checks, keyboard navigation, focus, chat, split decks, modals and storage warnings. These suites create isolated Go servers and disposable fixture repositories. They require Go and either Playwright Chromium or `RELAY_CHROME` pointing to an existing compatible browser.

State export is in Settings. Imported tasks display an explicit read-only-history banner and can create a fresh draft. Clean up accepted/published worktrees from the task menu; checkpoint history stays accessible from the workflow graph.

Settings also includes routing evidence and optional desktop notifications. Repository profiles group general settings, workspace strategy, structured checks/setup, integrations and Markdown guidance into keyboard-accessible tabs. Command arguments are literal arrays; saving a profile never executes them. Earlier activity remains stable while browsing, with an explicit return to live output. Browser tests cover dark control contrast and usable mobile chat geometry; set `RELAY_TEST_ARTIFACTS` to save audit screenshots.
