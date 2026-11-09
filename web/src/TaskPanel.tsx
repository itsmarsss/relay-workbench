import { useEffect, useState } from 'react';
import { asObject, asText, latestHandoffs, liveTerminal, eventPage } from './task-data';
import { statusLabel, taskViews, type Task, type TaskView } from './types';

type Data = {
  entries?: { title: string; text: string; key: string }[];
  output?: string;
  label?: string;
  message?: string;
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
    [error, setError] = useState('');
  useEffect(() => {
    setData({});
    setError('');
    if (view === 'overview' || view === 'diff') return;
    let alive = true,
      running = false,
      controller: AbortController | null = null;
    const base = `/api/tasks/${encodeURIComponent(task.id)}`;
    let cursor = 0,
      retained: NonNullable<Data['entries']> = [];
    async function refresh() {
      if (running) return;
      running = true;
      controller = new AbortController();
      try {
        let result: Data;
        if (view === 'thread' || view === 'transcript') {
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
      }
    }
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [task.id, view]);
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
        <p className="placeholder">
          Code changes and review controls are not ported yet. Use the existing Relay for review.
        </p>
      )}
      {view === 'terminals' && (
        <>
          <p className="placeholder">
            Read-only preview. Interactive terminal control is not ported.
          </p>
          {data.label && <strong>{data.label}</strong>}
          <pre className="terminal">{data.output || data.message || 'Waiting for output…'}</pre>
        </>
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
