import { useEffect, useState } from 'react';
import { DiffViewer } from './DiffViewer';
import { ActivityPanel, HandoffsPanel } from './ActivityPanel';
import { TerminalPanel } from './TerminalPanel';
import { asObject, asText, parseDiff, type DiffRepository } from './task-data';
import { statusLabel, taskViews, type Task, type TaskView } from './types';
import { ProviderName } from './Icons';

type Data = { diffs?: DiffRepository[]; diffRevision?: string; diffFingerprint?: string };
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
    if (view !== 'diff') return;
    let alive = true;
    const controller = new AbortController();
    void get(`/api/tasks/${encodeURIComponent(task.id)}/diff`, controller.signal)
      .then((response) => {
        if (!alive) return;
        const metadata = asObject(response);
        setData({
          diffs: parseDiff(response),
          diffRevision: asText(metadata?.taskRevision),
          diffFingerprint: asText(metadata?.fingerprint),
        });
      })
      .catch((failure) => {
        if (alive && !controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Could not load changes.');
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [task.id, view, refreshVersion]);
  if (view === 'thread' || view === 'transcript')
    return <ActivityPanel taskId={task.id} logs={view === 'transcript'} />;
  if (view === 'handoffs') return <HandoffsPanel taskId={task.id} />;
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
              <dd>
                <ProviderName provider={task.currentRun.harness} />
              </dd>
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
      {view === 'diff' &&
        (data.diffs ? (
          <DiffViewer
            taskId={task.id}
            repositories={data.diffs}
            revision={data.diffRevision || ''}
            fingerprint={data.diffFingerprint || ''}
            refresh={() => setRefreshVersion((value) => value + 1)}
          />
        ) : (
          !error && <p role="status">Loading changes…</p>
        ))}
    </div>
  );
}
