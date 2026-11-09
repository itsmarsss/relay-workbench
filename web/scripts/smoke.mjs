import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

await mkdir('dist/ssr-smoke', { recursive: true });
await build({
  entryPoints: [
    'src/App.tsx',
    'src/TaskPanel.tsx',
    'src/TaskPicker.tsx',
    'src/TasksPage.tsx',
    'src/RepositoriesPage.tsx',
    'src/DraftComposer.tsx',
    'src/RepositoryEditor.tsx',
    'src/Markdown.tsx',
    'src/StoragePage.tsx',
  ],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outdir: 'dist/ssr-smoke',
  jsx: 'automatic',
  target: 'node24',
});
const { default: App } = await import(pathToFileURL(resolve('dist/ssr-smoke/App.js')).href);
const { TaskPanel } = await import(pathToFileURL(resolve('dist/ssr-smoke/TaskPanel.js')).href);
const { TaskPicker } = await import(pathToFileURL(resolve('dist/ssr-smoke/TaskPicker.js')).href);
const { TasksPage } = await import(pathToFileURL(resolve('dist/ssr-smoke/TasksPage.js')).href);
const { RepositoriesPage } = await import(
  pathToFileURL(resolve('dist/ssr-smoke/RepositoriesPage.js')).href
);
const { DraftComposer } = await import(
  pathToFileURL(resolve('dist/ssr-smoke/DraftComposer.js')).href
);
const { RepositoryEditor } = await import(
  pathToFileURL(resolve('dist/ssr-smoke/RepositoryEditor.js')).href
);
const { Markdown } = await import(pathToFileURL(resolve('dist/ssr-smoke/Markdown.js')).href);
const { StoragePage } = await import(pathToFileURL(resolve('dist/ssr-smoke/StoragePage.js')).href);
const shell = renderToStaticMarkup(React.createElement(App));
assert.match(shell, /Task deck/);
assert.match(shell, /Migration in progress/);
assert.match(shell, /All tasks/);
assert.match(shell, /Repositories/);
const panel = renderToStaticMarkup(
  React.createElement(TaskPanel, {
    task: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: '<img src=x onerror=alert(1)>',
      status: 'draft',
      repository: { id: 'r', name: 'Repo' },
    },
    view: 'overview',
  }),
);
assert.ok(!panel.includes('<img'));
assert.match(panel, /&lt;img/);
const picker = renderToStaticMarkup(
  React.createElement(TaskPicker, {
    id: 'sample',
    tasks: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: '<script>unsafe</script>',
        status: 'draft',
      },
    ],
    selected: '550e8400-e29b-41d4-a716-446655440000',
    onChange: () => {},
  }),
);
assert.ok(!picker.includes('<script>'));
assert.match(picker, /&lt;script&gt;/);

const config = {
  repositories: [
    {
      id: 'r',
      name: '<img onerror=bad>',
      path: '/example',
      cwd: '.',
      strategy: 'worktree',
      verificationMode: 'agent',
      checks: [],
      setup: [],
      instructions: '',
    },
  ],
};
const task = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  title: '<script>unsafe</script>',
  status: 'draft',
  repository: { id: 'r', name: 'Example' },
};
const board = renderToStaticMarkup(
  React.createElement(TasksPage, { tasks: [task], onOpen: () => {}, onCreate: () => {} }),
);
assert.ok(!board.includes('<script>'));
assert.match(board, /&lt;script&gt;/);
const repos = renderToStaticMarkup(
  React.createElement(RepositoriesPage, { config, onAdd: () => {}, onEdit: () => {} }),
);
assert.ok(!repos.includes('<img'));
assert.match(repos, /&lt;img/);
const draft = renderToStaticMarkup(
  React.createElement(DraftComposer, {
    config,
    onCreate: async () => task,
    onClose: () => {},
    onCreated: () => {},
  }),
);
assert.match(draft, /Create draft/);
assert.ok(!draft.includes('<img'));
const editor = renderToStaticMarkup(
  React.createElement(RepositoryEditor, {
    config,
    revision: 'x',
    onSave: async () => {},
    onClose: () => {},
  }),
);
assert.match(editor, /Add repository/);
const markup = renderToStaticMarkup(
  React.createElement(Markdown, { text: '<script>alert(1)</script>' }),
);
assert.ok(!markup.includes('<script>'));
const storageReport = {
  policy: {
    enabled: true,
    warningPercent: 10,
    criticalPercent: 3,
    warningBytes: 10737418240,
    criticalBytes: 2147483648,
    monitoredPaths: [],
  },
  revision: 'a'.repeat(64),
  scope: 'Relay data volume',
  admissionEnforced: false,
  automaticCleanup: false,
  pressure: {
    state: 'warning',
    message: 'Free space is low.',
    warningThreshold: '100',
    criticalThreshold: '20',
    space: { totalBytes: '1000', availableBytes: '50' },
  },
};
const storage = renderToStaticMarkup(
  React.createElement(StoragePage, {
    token: 'x',
    report: storageReport,
    loadError: '',
    refresh: async () => {},
  }),
);
assert.match(storage, /Low space/);
assert.match(storage, /Automatic cleanup/);
assert.match(storage, /not connected/);
console.log('React server-render smoke test passed.');
