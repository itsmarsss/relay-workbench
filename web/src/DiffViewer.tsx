import { useMemo, useState } from 'react';
import { splitDiff, type DiffLine } from './diff';
import { Modal } from './Modal';
import { Markdown } from './Markdown';
import { Notice, useResource, useMutation } from './Session';
import { asObject, asText, type DiffRepository } from './task-data';
import type { FullTask } from './TaskExtras';

type ViewFile = {
  key: string;
  path: string;
  status: '' | 'Added' | 'Deleted' | 'Renamed' | 'Untracked';
  from: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  // Too much to read in passing: starts folded, the way a code host hides a large diff.
  large: boolean;
};
const longLine = 1500;
function viewFile(
  key: string,
  path: string,
  lines: DiffLine[],
  status: ViewFile['status'] = '',
  from = '',
): ViewFile {
  let additions = 0,
    deletions = 0,
    size = 0;
  const shown: DiffLine[] = [];
  for (const row of lines) {
    size += row.text.length;
    if (row.kind === 'addition') additions++;
    else if (row.kind === 'deletion') deletions++;
    else if (row.kind === 'meta') {
      // Git's own bookkeeping says what happened to the file; only notes about content are shown.
      if (row.text.startsWith('new file mode')) status = 'Added';
      else if (row.text.startsWith('deleted file mode')) status = 'Deleted';
      else if (row.text.startsWith('rename from ')) status = 'Renamed';
      if (!/^(Binary files |\\ )/.test(row.text)) continue;
    }
    shown.push(row);
  }
  return {
    key,
    path,
    status,
    from: status === 'Renamed' ? from : '',
    lines: shown,
    additions,
    deletions,
    large: additions + deletions > 400 || size > 60000,
  };
}
function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-counts">
      {additions > 0 && <span className="diff-plus">+{additions}</span>}
      {deletions > 0 && <span className="diff-minus">−{deletions}</span>}
    </span>
  );
}
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <span className="diff-path">
      {cut > 0 && <span>{path.slice(0, cut)}</span>}
      <strong>{path.slice(cut)}</strong>
    </span>
  );
}

export function DiffViewer({
  taskId,
  repositories,
  revision,
  fingerprint,
  refreshing,
  refresh,
}: {
  taskId: string;
  repositories: DiffRepository[];
  revision: string;
  fingerprint: string;
  refreshing?: boolean;
  refresh: () => void;
}) {
  const current = useResource<FullTask>(`/api/tasks/${taskId}`),
    mutation = useMutation();
  const [anchor, setAnchor] = useState<{
      repositoryId: string;
      file: string;
      line: number;
      side: string;
    } | null>(null),
    [text, setText] = useState(''),
    [folded, setFolded] = useState<Record<string, boolean>>({});
  const groups = useMemo(
    () =>
      repositories.map((repo) => ({
        repo,
        files: [
          ...splitDiff(repo.text).map((file, index) =>
            viewFile(`${repo.id}:${index}:${file.path}`, file.path, file.lines, '', file.oldPath),
          ),
          ...repo.untracked.map((file) =>
            viewFile(
              `${repo.id}:new:${file.name}`,
              file.name,
              file.content
                .replace(/\n$/, '')
                .split('\n')
                .slice(0, 4000)
                .map((line, index) => ({
                  text: '+' + line,
                  kind: 'addition' as const,
                  old: null,
                  next: index + 1,
                })),
              'Untracked',
            ),
          ),
        ],
      })),
    [repositories],
  );
  const files = groups.flatMap((group) => group.files),
    isFolded = (file: ViewFile) => folded[file.key] ?? file.large,
    allFolded = files.length > 0 && files.every(isFolded);
  const fold = (file: ViewFile, value: boolean) =>
    setFolded((state) => (isFolded(file) === value ? state : { ...state, [file.key]: value }));
  const anchorId = (file: ViewFile) => `diff-${taskId}-${files.indexOf(file)}`;
  const task = current.data,
    comments = Array.isArray(task?.reviewComments)
      ? task.reviewComments.map(asObject).filter(Boolean)
      : [];
  const canComment = task?.status === 'awaiting_final';
  async function comment() {
    await mutation.run(`/api/tasks/${taskId}/review-comment`, {
      ...anchor,
      taskRevision: revision,
      fingerprint,
      text,
    });
    setAnchor(null);
    setText('');
    refresh();
  }
  function line(row: DiffLine, index: number, file: string, repo: string) {
    const number = row.next ?? row.old;
    if (row.kind === 'hunk' || row.kind === 'meta')
      return (
        <span className={`diff-row ${row.kind}`} key={index}>
          <span className="diff-line-number" />
          <span className="diff-line-number" />
          <span />
          <span className="diff-line-text">{row.text.replace(/^\\ /, '')}</span>
        </span>
      );
    const extra = row.text.length - longLine;
    return (
      <span className={`diff-row ${row.kind}`} key={index}>
        <span className="diff-line-number">{row.old}</span>
        <span className="diff-line-number">{row.next}</span>
        <button
          type="button"
          className="diff-add-comment"
          aria-label={`Comment on ${file}:${number}`}
          disabled={!canComment || number === null}
          onClick={() => {
            setText('');
            setAnchor({
              repositoryId: repo,
              file,
              line: number!,
              side: row.next === null ? 'old' : 'new',
            });
          }}
        >
          +
        </button>
        <span className="diff-line-text">
          {extra > 0 ? row.text.slice(0, longLine) : row.text || ' '}
          {extra > 0 && (
            <em className="diff-line-more"> … {extra.toLocaleString()} more characters</em>
          )}
        </span>
      </span>
    );
  }
  return (
    <div className="diff-viewer">
      <div className="diff-toolbar">
        <h3>
          {files.length === 1 ? '1 file changed' : `${files.length} files changed`}
          <Counts
            additions={files.reduce((sum, file) => sum + file.additions, 0)}
            deletions={files.reduce((sum, file) => sum + file.deletions, 0)}
          />
        </h3>
        <div className="inline">
          {files.length > 1 && (
            <button
              type="button"
              onClick={() =>
                setFolded(Object.fromEntries(files.map((file) => [file.key, !allFolded])))
              }
            >
              {allFolded ? 'Expand all' : 'Collapse all'}
            </button>
          )}
          <button onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh changes'}
          </button>
        </div>
      </div>
      {files.length > 1 && (
        <details className="diff-index">
          <summary>Jump to file</summary>
          <ul>
            {files.map((file) => (
              <li key={file.key}>
                <button
                  type="button"
                  onClick={() => {
                    fold(file, false);
                    requestAnimationFrame(() =>
                      document.getElementById(anchorId(file))?.scrollIntoView({ block: 'start' }),
                    );
                  }}
                >
                  <FilePath path={file.path} />
                  <Counts additions={file.additions} deletions={file.deletions} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {groups.map(({ repo, files: repoFiles }) => (
        <section key={repo.id} className="diff-repository">
          {repositories.length > 1 && <h3>{repo.name}</h3>}
          {repo.message && (
            <p className="diff-notice" role="status">
              {repo.message}
            </p>
          )}
          {repoFiles.map((file) => (
            <details
              key={file.key}
              id={anchorId(file)}
              className="diff-file"
              open={!isFolded(file)}
              onToggle={(event) => fold(file, !event.currentTarget.open)}
            >
              <summary>
                <FilePath path={file.path} />
                {file.status && (
                  <span className={`diff-status diff-status-${file.status.toLowerCase()}`}>
                    {file.status}
                  </span>
                )}
                {file.from && file.from !== file.path && (
                  <small className="diff-from">from {file.from}</small>
                )}
                {file.large && isFolded(file) && <small className="diff-from">Large diff</small>}
                <Counts additions={file.additions} deletions={file.deletions} />
              </summary>
              {!isFolded(file) && (
                <div className="diff-code" aria-label={`Changes in ${repo.name}: ${file.path}`}>
                  {file.lines.length ? (
                    file.lines.map((row, i) => line(row, i, file.path, repo.id))
                  ) : (
                    <span className="diff-row meta">
                      <span className="diff-line-number" />
                      <span className="diff-line-number" />
                      <span />
                      <span className="diff-line-text">No content changes.</span>
                    </span>
                  )}
                </div>
              )}
            </details>
          ))}
          {repo.omittedCount > 0 && <p>{repo.omittedCount} files omitted from preview.</p>}
          {!repo.text && !repo.untracked.length && !repo.message && (
            <p className="muted">No changes.</p>
          )}
        </section>
      ))}
      {comments.length > 0 && (
        <section className="review-comments">
          <h3>Review comments</h3>
          {comments.map((comment) => (
            <article key={asText(comment?.id)} className="review-comment">
              <div className="section-heading">
                <strong>
                  {asText(comment?.file)}:{String(comment?.line)}
                </strong>
                <button
                  disabled={mutation.busy || !canComment}
                  onClick={() => {
                    void mutation
                      .run(`/api/tasks/${taskId}/review-comment`, {
                        taskRevision: task?.taskRevision,
                        commentId: comment?.id,
                        resolved: comment?.resolved !== true,
                      })
                      .then(refresh)
                      .catch(() => {});
                  }}
                >
                  {comment?.resolved === true ? 'Reopen' : 'Resolve'}
                </button>
              </div>
              <Markdown text={asText(comment?.text)} />
            </article>
          ))}
        </section>
      )}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {anchor && (
        <Modal
          title={`Comment on ${anchor.file}:${anchor.line}`}
          onClose={() => setAnchor(null)}
          onSubmit={(event) => {
            event.preventDefault();
            void comment().catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setAnchor(null)}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy || !text.trim()}>
                Add comment
              </button>
            </>
          }
        >
          <label className="field">
            Review comment
            <textarea
              autoFocus
              rows={4}
              required
              maxLength={10000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </div>
  );
}
