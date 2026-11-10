import { useEffect, useState } from 'react';
import { TerminalPanel } from './TerminalPanel';
import {
  asObject,
  asText,
  latestHandoffs,
  liveTerminal,
  eventPage,
  parseDiff,
  diffPreviewLines,
  type DiffRepository,
} from './task-data';
import { statusLabel, taskViews, type Task, type TaskView } from './types';

type Data = {
  entries?: { title: string; text: string; key: string }[];
  output?: string;
  label?: string;
  message?: string;
  diffs?: DiffRepository[];
};
async function get(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'This view is not available in the experimental backend yet.'
        : `Could not load this view (${response.status}).`,
    );
  return response.json() as Promise<unknown>;
}
export function TaskPanel({ task, view }: { task: Task; view: TaskView }) {
  const [data, setData] = useState<Data>({}),
    [error, setError] = useState(''),
    [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    setData({});
    setError('');
    if (view === 'overview' || view === 'terminals') return;
    let alive = true,
      running = false,
      controller: AbortController | null = null,
      pending = false,
      refreshTimer: number | undefined;
    const base = `/api/tasks/${encodeURIComponent(task.id)}`;
    let cursor = 0,
      retained: NonNullable<Data['entries']> = [];
    async function refresh() {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      controller = new AbortController();
      try {
        let result: Data;
        if (view === 'diff') {
          result = { diffs: parseDiff(await get(`${base}/diff`, controller.signal)) };
        } else if (view === 'thread' || view === 'transcript') {
          for (let page = 0; page < 5; page++) {
            const batch = eventPage(
              await get(`${base}/events?after=${cursor}`, controller.signal),
              cursor,
              view === 'thread' ? 'activity' : 'logs',
            );
            cursor = batch.cursor;
            retained = [...retained, ...batch.entries].slice(-50);
            if (!batch.more) break;
          }
          result = { entries: retained };
        } else if (view === 'handoffs')
          result = { entries: latestHandoffs(await get(base, controller.signal)) };
        else {
          const selection = liveTerminal(await get(base, controller.signal));
          if (!selection)
            result = { message: 'No live terminal. Open the task in Relay for retained output.' };
          else {
            const preview = asObject(
              await get(
                `${base}/terminal-preview?attemptId=${encodeURIComponent(selection.id)}`,
                controller.signal,
              ),
            );
            result = {
              label: selection.label,
              output: asText(preview?.output, 50000),
              message: asText(preview?.message, 1000),
            };
          }
        }
        if (alive) {
          setData(result);
          setError('');
        }
      } catch (failure) {
        if (alive && !(failure instanceof DOMException && failure.name === 'AbortError'))
          setError(failure instanceof Error ? failure.message : 'Could not load this view.');
      } finally {
        running = false;
        if (alive && pending) {
          pending = false;
          void refresh();
        }
      }
    }
    function onData() {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 200);
    }
    void refresh();
    if (view !== 'diff') window.addEventListener('relay-data-change', onData);
    const interval =
      view === 'diff'
        ? undefined
        : window.setInterval(() => {
            if (!document.hidden) void refresh();
          }, 5000);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(interval);
      window.clearTimeout(refreshTimer);
      window.removeEventListener('relay-data-change', onData);
    };
  }, [task.id, view, refreshVersion]);
  if (view === 'terminals') return <TerminalPanel taskId={task.id} />;
  if (view === 'overview')
    return (
      <div className="pane-content">
        <span className="eyebrow">{statusLabel(task.status)}</span>
        <h3>{task.title}</h3>
        <p>{task.latestSummary || task.error || 'No recent update.'}</p>
        <dl>
          <div>
            <dt>Repository</dt>
            <dd>{task.repository?.name || 'Unspecified'}</dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>{task.currentRun?.stage || task.stage || 'Not started'}</dd>
          </div>
          {task.currentRun?.harness && (
            <div>
              <dt>Agent</dt>
              <dd>{task.currentRun.harness}</dd>
            </div>
          )}
        </dl>
      </div>
    );
  return (
    <div className="pane-content" aria-label={taskViews.find((item) => item.id === view)?.label}>
      {error && (
        <p role="status" className="error">
          {error}
        </p>
      )}
      {view === 'diff' && (
        <div className="diff-preview">
          <button onClick={() => setRefreshVersion((value) => value + 1)}>Refresh changes</button>
          {!data.diffs && !error && <p role="status">Loading changes…</p>}
          {data.diffs?.map((repo) => {
            const preview = diffPreviewLines(repo.text);
            return (
              <section key={repo.id} className="diff-repository">
                <h3>{repo.name}</h3>
                {repo.message && <p>{repo.message}</p>}
                {repo.stat && <pre className="diff-stat">{repo.stat}</pre>}
                {preview.lines.length > 0 && (
                  <pre className="diff-code" tabIndex={0} aria-label={`Changes in ${repo.name}`}>
                    {preview.lines.map((line, index) => (
                      <span key={index} className={line.kind}>
                        {line.text}
                      </span>
                    ))}
                  </pre>
                )}
                {preview.truncated && (
                  <p>Preview limited to 4,000 lines; inspect the full diff locally.</p>
                )}
                {repo.untracked.map((file) => (
                  <div key={file.name}>
                    <h4>New file: {file.name}</h4>
                    <pre className="diff-code addition" tabIndex={0}>
                      {file.content}
                    </pre>
                  </div>
                ))}
                {repo.omittedCount > 0 && (
                  <p>{repo.omittedCount} untracked previews omitted; inspect them locally.</p>
                )}
                {!repo.message && !repo.text && !repo.untracked.length && <p>No changes found.</p>}
              </section>
            );
          })}
        </div>
      )}
      {data.entries &&
        (data.entries.length ? (
          <ol className="entries">
            {data.entries.map((entry) => (
              <li key={entry.key}>
                <strong>{entry.title}</strong>
                <p>{entry.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="placeholder">No {view === 'handoffs' ? 'handoffs' : 'activity'} yet.</p>
        ))}
    </div>
  );
}
