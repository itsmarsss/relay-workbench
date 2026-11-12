import { useEffect, useState } from 'react';
import { DiffViewer } from './DiffViewer';
import { ActivityPanel, HandoffsPanel } from './ActivityPanel';
import { TerminalPanel } from './TerminalPanel';
import { asObject, asText, parseDiff, type DiffRepository } from './task-data';
import { statusLabel, taskViews, type Task, type TaskView } from './types';
import { ProviderName } from './Icons';
import { currentStage, stageNames } from './presentation';

type Data = {
  diffs?: DiffRepository[];
  diffRevision?: string;
  diffFingerprint?: string;
  body?: string;
};
async function get(path: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'This view is not available in the experimental backend yet.'
        : `Could not load this view (${response.status}).`,
    );
  return response.text();
}
// Reading a large checkout takes the server seconds, so the last changes loaded for the few most
// recent tasks stay here: reopening the tab shows them at once while a fresh copy is fetched.
const recentDiffs = new Map<string, Data>();
function remember(taskId: string, data: Data) {
  recentDiffs.delete(taskId);
  recentDiffs.set(taskId, data);
  for (const oldest of recentDiffs.keys()) {
    if (recentDiffs.size <= 4) break;
    recentDiffs.delete(oldest);
  }
}
export function TaskPanel({ task, view }: { task: Task; view: TaskView }) {
  const stage = currentStage(task);
  const [data, setData] = useState<Data>({}),
    [error, setError] = useState(''),
    [refreshing, setRefreshing] = useState(false),
    [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    const known = view === 'diff' ? recentDiffs.get(task.id) : undefined;
    setData(known || {});
    setError('');
    if (view !== 'diff') return;
    let alive = true;
    const controller = new AbortController();
    setRefreshing(true);
    void get(`/api/tasks/${encodeURIComponent(task.id)}/diff`, controller.signal)
      .then((body) => {
        if (!alive) return;
        setRefreshing(false);
        // Unchanged since last time: keep what is on screen rather than rebuilding every row.
        if (body === known?.body) return;
        const response: unknown = JSON.parse(body);
        const metadata = asObject(response);
        const next = {
          diffs: parseDiff(response),
          diffRevision: asText(metadata?.taskRevision),
          diffFingerprint: asText(metadata?.fingerprint),
          body,
        };
        remember(task.id, next);
        setData(next);
      })
      .catch((failure) => {
        if (!alive || controller.signal.aborted) return;
        setRefreshing(false);
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
      <div className="pane-content" tabIndex={0}>
        <span className="eyebrow">{statusLabel(task.status)}</span>
        <h2>{task.title}</h2>
        <p className={task.error ? 'pane-summary-error' : undefined}>
          {task.error || task.latestSummary || 'No recent update.'}
        </p>
        <dl>
          <div>
            <dt>Repository</dt>
            <dd>{task.repository?.name || 'Unspecified'}</dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>{stageNames[stage] || stage || 'Not started'}</dd>
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
            refreshing={refreshing}
            refresh={() => setRefreshVersion((value) => value + 1)}
          />
        ) : (
          !error && <p role="status">Loading changes…</p>
        ))}
    </div>
  );
}
