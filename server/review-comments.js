import { randomUUID } from 'node:crypto';
import { diff, fingerprint } from './workspace.js';
import { requireValue, text } from './domain.js';
import { diffLines } from '../public/diff-lines.js';
export async function snapshotDiff(task) {
  if (task.demo || !task.workspace) return diff(task);
  const before = await fingerprint(task);
  const snapshot = await diff(task);
  requireValue(
    before === (await fingerprint(task)),
    'Workspace changed while loading the diff; refresh',
    409,
  );
  return { ...snapshot, fingerprint: before };
}
export async function addComment(task, data) {
  requireValue(
    task.status === 'awaiting_final' && !task.demo,
    'Inline review is available at final approval',
    409,
  );
  const snapshot = await snapshotDiff(task);
  requireValue(
    data.fingerprint === snapshot.fingerprint,
    'This diff is stale; refresh before commenting',
    409,
  );
  const repositoryId = data.repositoryId ?? task.repository.id;
  const repositoryDiff =
    snapshot.repositories?.find((r) => r.repositoryId === repositoryId) ??
    (repositoryId === task.repository.id ? snapshot : null);
  requireValue(repositoryDiff, 'Repository is not part of this diff');
  const match = diffLines(repositoryDiff).find(
    ({ anchor }) =>
      anchor &&
      ['path', 'side', 'line', 'content'].every((key) => anchor[key] === data.anchor?.[key]),
  );
  requireValue(match, 'The selected line is not present in this diff');
  const comment = {
    id: randomUUID(),
    repositoryId,
    anchor: match.anchor,
    fingerprint: snapshot.fingerprint,
    text: text(data.text, 'Review comment', 10000),
    status: 'open',
    at: new Date().toISOString(),
  };
  (task.reviewComments ??= []).push(comment);
  return comment;
}
export async function focusedFeedback(task, ids) {
  requireValue(
    Array.isArray(ids) && ids.length > 0 && ids.length <= 100,
    'Select between 1 and 100 review comments',
  );
  const comments = ids.map((id) =>
    task.reviewComments?.find((c) => c.id === id && c.status === 'open'),
  );
  requireValue(
    comments.every(Boolean) && new Set(ids).size === ids.length,
    'Selected review comments changed; refresh',
    409,
  );
  const current = await fingerprint(task);
  requireValue(
    comments.every((c) => c.fingerprint === current),
    'Selected comments refer to an older workspace; refresh and comment on current lines',
    409,
  );
  for (const comment of comments) comment.status = 'submitted';
  return comments
    .map(
      (c) =>
        `Repository ${c.repositoryId} · ${c.anchor.path}:${c.anchor.line} (${c.anchor.side})\n${c.anchor.content}\nRequested repair: ${c.text}`,
    )
    .join('\n\n');
}
