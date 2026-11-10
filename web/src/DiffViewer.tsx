import { useState } from 'react';
import { splitDiff, type DiffLine } from './diff';
import { Modal } from './Modal';
import { Markdown } from './Markdown';
import { Notice, useResource, useMutation } from './Session';
import { asObject, asText, type DiffRepository } from './task-data';
import type { FullTask } from './TaskExtras';

export function DiffViewer({
  taskId,
  repositories,
  revision,
  fingerprint,
  refresh,
}: {
  taskId: string;
  repositories: DiffRepository[];
  revision: string;
  fingerprint: string;
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
    [text, setText] = useState('');
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
        <span className="diff-line-text">{row.text || ' '}</span>
      </span>
    );
  }
  return (
    <div className="diff-viewer">
      <div className="section-heading">
        <h3>Changes</h3>
        <button onClick={refresh}>Refresh changes</button>
      </div>
      {repositories.map((repo) => (
        <section key={repo.id} className="diff-repository">
          <h3>{repo.name}</h3>
          {repo.message && (
            <p className="diff-notice" role="status">
              {repo.message}
            </p>
          )}
          {repo.stat && (
            <details>
              <summary>Change summary</summary>
              <pre>{repo.stat}</pre>
            </details>
          )}
          {splitDiff(repo.text).map((file, index) => (
            <details open key={file.path + index} className="diff-file">
              <summary>{file.path}</summary>
              <div
                className="diff-code"
                role="region"
                tabIndex={0}
                aria-label={`Changes in ${repo.name}: ${file.path}`}
              >
                {file.lines.map((row, i) => line(row, i, file.path, repo.id))}
              </div>
            </details>
          ))}
          {repo.untracked.map((file) => (
            <details open className="diff-file" key={file.name}>
              <summary>
                <span className="file-new">New</span> {file.name}
              </summary>
              <div
                className="diff-code"
                role="region"
                tabIndex={0}
                aria-label={`New file ${file.name}`}
              >
                {file.content
                  .split('\n')
                  .slice(0, 4000)
                  .map((text, index) =>
                    line(
                      { text: '+' + text, kind: 'addition', old: null, next: index + 1 },
                      index,
                      file.name,
                      repo.id,
                    ),
                  )}
              </div>
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
