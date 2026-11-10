import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { Icon, ProviderName } from './UI';
import { Notice, useResource } from './Session';
import { CheckpointControls, type History } from './WorkflowHistory';
import { executionLayout } from './execution';
import { asObject, asText } from './task-data';
import type { FullTask } from './TaskExtras';
const names: Record<string, string> = {
  triage: 'Routing',
  investigate: 'Investigation',
  plan: 'Planning',
  implement: 'Implementation',
  verify: 'Verification',
  review: 'Review',
  publish: 'Publication',
  followup: 'Follow-up',
};
export function ExecutionGraph({ task }: { task: FullTask }) {
  const history = useResource<History>(`/api/tasks/${task.id}/history`),
    graph = executionLayout(task, history.data);
  const [selected, setSelected] = useState(''),
    [zoom, setZoom] = useState(1),
    canvas = useRef<HTMLDivElement>(null);
  const active = graph.byId.get(selected) || graph.nodes.filter((n) => n.kind === 'run').at(-1);
  useEffect(() => {
    const target = canvas.current?.querySelector<HTMLElement>(
      `[data-graph-id="${selected.replace(/[^a-zA-Z0-9-]/g, '')}"]`,
    );
    const viewport = canvas.current;
    if (target && viewport) {
      const rect = target.getBoundingClientRect(),
        bounds = viewport.getBoundingClientRect();
      viewport.scrollTo({
        left: viewport.scrollLeft + rect.left - bounds.left - (bounds.width - rect.width) / 2,
        top: viewport.scrollTop + rect.top - bounds.top - (bounds.height - rect.height) / 2,
        behavior: document.documentElement.dataset.lowMotion === 'true' ? 'instant' : 'smooth',
      });
    }
  }, [selected, zoom]);
  const graphHeight = Math.min(460, Math.max(210, graph.height * zoom + 16));
  return (
    <section className="surface execution-section">
      <div className="section-heading">
        <div>
          <h2>Execution</h2>
          <small className="muted">
            {graph.nodes.filter((n) => n.kind === 'run').length} runs ·{' '}
            {task.currentRun?.harness || 'No active agent'}
          </small>
        </div>
        <div className="execution-tools">
          <CheckpointControls task={task} history={history.data} />
          <button
            className="icon-button"
            aria-label="Focus current run"
            onClick={() => {
              setSelected('');
              requestAnimationFrame(() =>
                setSelected(graph.nodes.filter((n) => n.kind === 'run').at(-1)?.id || ''),
              );
            }}
          >
            <Icon name="search" size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
          >
            <Icon name="minus" size={16} />
          </button>
          <button
            className="text-button graph-zoom"
            aria-label="Reset graph zoom"
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="icon-button"
            aria-label="Zoom in"
            disabled={zoom >= 1.5}
            onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
      </div>
      {history.error && <Notice>{history.error}</Notice>}
      {!graph.nodes.length ? (
        <p className="muted">The execution path appears when this task starts.</p>
      ) : (
        <>
          <div className="graph-legend">
            <span>Workflow</span>
            <span>Diagnosis</span>
            <span>Delivery</span>
            {(history.data?.forks.length || 0) > 0 && <span>Checkpoint branches</span>}
            {asObject(task.automation)?.enabled === true && <strong>Auto authorized</strong>}
          </div>
          <div
            className="execution-canvas"
            ref={canvas}
            aria-label="Execution graph"
            style={{ height: graphHeight }}
          >
            <div
              className="execution-world"
              style={{ width: graph.width * zoom, height: graph.height * zoom }}
            >
              <div
                style={{
                  width: graph.width,
                  height: graph.height,
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              >
                <svg
                  className="graph-edges"
                  width={graph.width}
                  height={graph.height}
                  aria-hidden="true"
                >
                  <defs>
                    <marker
                      id={`arrow-${task.id}`}
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                    >
                      <path d="M0 0 8 4 0 8Z" fill="currentColor" />
                    </marker>
                  </defs>
                  {graph.edges.map((edge) => {
                    const from = graph.byId.get(edge.from)!,
                      to = graph.byId.get(edge.to)!,
                      x1 = from.x + 190,
                      y1 = from.y + 46,
                      x2 = to.x,
                      y2 = to.y + 46;
                    return (
                      <g
                        key={`${edge.from}:${edge.to}`}
                        className={edge.branch ? 'graph-branch' : ''}
                      >
                        <path
                          d={`M${x1},${y1} C${x1 + 28},${y1} ${x2 - 28},${y2} ${x2},${y2}`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          markerEnd={`url(#arrow-${task.id})`}
                        />
                        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10} textAnchor="middle">
                          {edge.label}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                {graph.nodes.map((node) => (
                  <button
                    key={node.id}
                    data-graph-id={node.id}
                    className={`graph-node ${node.id === active?.id ? 'selected' : ''} ${node.row.status === 'running' ? 'is-running' : ''} ${node.row.inherited ? 'inherited' : ''} ${node.kind === 'fork' ? 'is-fork' : ''}`}
                    style={{ left: node.x, top: node.y, width: 190 }}
                    onClick={() => setSelected(node.id)}
                    aria-pressed={active?.id === node.id}
                  >
                    <span className="graph-node-label">
                      {node.kind === 'fork'
                        ? 'Checkpoint branch'
                        : node.row.role === 'debug'
                          ? 'Debugger'
                          : names[asText(node.row.stage)] || asText(node.row.stage)}
                    </span>
                    <strong>
                      {node.kind === 'fork' ? (
                        asText(node.row.title)
                      ) : (
                        <ProviderName provider={asText(node.row.harness)} size={22} />
                      )}
                    </strong>
                    <small>
                      <span className={`graph-status ${asText(node.row.status)}`} />
                      {asText(node.row.status)}
                      {node.row.inherited ? ' · inherited' : ''}
                    </small>
                    {!!node.checkpoints.length && (
                      <span className="graph-saved" title="Saved checkpoint">
                        Checkpoint · {node.checkpoints.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {active && (
            <div className="execution-detail">
              <div className="section-heading">
                <h3>
                  {active.kind === 'fork'
                    ? 'Checkpoint branch'
                    : active.row.role === 'debug'
                      ? 'Debugger'
                      : names[asText(active.row.stage)] || asText(active.row.stage)}{' '}
                  · <ProviderName provider={asText(active.row.harness)} size={22} />
                </h3>
                <small>{asText(active.row.model) || 'Provider default model'}</small>
              </div>
              {active.kind === 'fork' ? (
                <a href={`#task/${asText(active.row.taskId)}/overview`}>
                  Open {asText(active.row.title)} →
                </a>
              ) : (
                <>
                  <Markdown
                    text={asText(
                      asObject(active.row.handoff)?.summary ||
                        active.row.error ||
                        active.row.summary ||
                        (active.row.status === 'running'
                          ? 'Agent is working…'
                          : 'No handoff recorded.'),
                    )}
                  />
                  {!!asObject(active.row.handoff)?.details && (
                    <details>
                      <summary>Run details</summary>
                      <Markdown text={asText(asObject(active.row.handoff)?.details)} />
                    </details>
                  )}
                  {!!active.checkpoints.length && (
                    <p className="muted">
                      A checkpoint preserves source and decisions from this run. Use Checkpoints to
                      continue from it.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
