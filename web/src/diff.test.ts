import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiff } from './diff.ts';
test('diff anchors preserve old/new line numbers and file boundaries', () => {
  const files = splitDiff(
    'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -7,2 +7,3 @@\n old\n-before\n+after\n+extra\ndiff --git a/deleted.txt b/deleted.txt\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted',
  );
  assert.equal(files[0]?.path, 'a.txt');
  assert.deepEqual(
    files[0]?.lines
      .filter((row) => ['addition', 'deletion'].includes(row.kind))
      .map((row) => [row.old, row.next]),
    [
      [8, null],
      [null, 8],
      [null, 9],
    ],
  );
  assert.equal(files[1]?.path, 'deleted.txt');
  assert.equal(files[1]?.lines.at(-1)?.old, 1);
});
test('Git octal paths, spaces, renames and binary files keep filenames', () => {
  const files = splitDiff(
    'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"\n--- "a/\\303\\251.txt"\n+++ "b/\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\ndiff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ',
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ['é.txt', 'new name', 'image.png'],
  );
  assert.equal(files[1]?.oldPath, 'old name');
});
