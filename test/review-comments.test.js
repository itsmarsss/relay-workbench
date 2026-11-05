import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffLines } from '../public/diff-lines.js';
import { snapshotDiff, addComment, focusedFeedback } from '../server/review-comments.js';
import { git } from '../server/workspace.js';
import { buildPrompt } from '../server/harness.js';

test('diff anchors track additions, deletions, context and new files', () => {
  const lines = diffLines({
    text: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -3,2 +3,2 @@\n-old\n+new\n same',
    untracked: [{ name: 'new.txt', content: 'first\nsecond' }],
  });
  assert.deepEqual(lines.find((l) => l.text === '-old').anchor, {
    path: 'a.txt',
    side: 'old',
    line: 3,
    content: 'old',
  });
  assert.equal(lines.find((l) => l.text === '+new').anchor.line, 3);
  assert.equal(lines.find((l) => l.text === ' same').anchor.line, 4);
  assert.equal(lines.find((l) => l.text === '+second').anchor.line, 2);
});

test('inline feedback rejects stale and invented lines and preserves repair context', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-comments-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'fixture']);
  await writeFile(join(root, 'file.txt'), 'before\n');
  await git(root, ['add', '.']);
  await git(root, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'test: fixture',
  ]);
  const task = {
    id: 'fixture',
    title: 'Fix a file',
    status: 'awaiting_final',
    repository: { id: 'repo', instructions: '' },
    workspace: root,
    workspaceRoot: root,
    baseCommit: await git(root, ['rev-parse', 'HEAD']),
    attempts: [],
    messages: [],
    approvals: [],
  };
  await writeFile(join(root, 'file.txt'), 'after\n');
  const snapshot = await snapshotDiff(task);
  const anchor = diffLines(snapshot).find((l) => l.text === '+after').anchor;
  await assert.rejects(addComment(task, { fingerprint: 'old', anchor, text: 'fix' }), /stale/);
  await assert.rejects(
    addComment(task, {
      fingerprint: snapshot.fingerprint,
      anchor: { ...anchor, path: '../escape' },
      text: 'fix',
    }),
    /not present/,
  );
  const comment = await addComment(task, {
    fingerprint: snapshot.fingerprint,
    anchor,
    text: 'Handle empty values',
  });
  const repair = await focusedFeedback(task, [comment.id]);
  assert.match(repair, /file.txt:1/);
  assert.match(repair, /Handle empty values/);
  assert.equal(comment.status, 'submitted');
  assert.match(buildPrompt(task, 'implement'), /focusedFeedback/);
  comment.status = 'open';
  await writeFile(join(root, 'file.txt'), 'changed again\n');
  await assert.rejects(focusedFeedback(task, [comment.id]), /older workspace/);
  assert.equal(comment.status, 'open');
  task.status = 'running';
  await assert.rejects(
    addComment(task, { fingerprint: snapshot.fingerprint, anchor, text: 'fix' }),
    /final approval/,
  );
});
