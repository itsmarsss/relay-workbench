import { useCallback, useEffect, useRef, useState } from 'react';
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
const NODE_WIDTH = 190,
  NODE_HEIGHT = 92,
  MIN_ZOOM = 0.08,
  // Below this the text on a run cannot be read, so the opening view never goes lower.
  READABLE_ZOOM = 0.6,
  MAX_ZOOM = 2;
type View = { x: number; y: number; z: number };
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
// The canvas's layout size. Its on-screen box is scaled while a drawer animates open, so that
// would give the wrong camera.
const size = (element: HTMLElement | null) =>
  element && element.clientWidth > 0
    ? { width: element.clientWidth, height: element.clientHeight }
    : null;
export function ExecutionGraph({ task }: { task: FullTask }) {
  const history = useResource<History>(`/api/tasks/${task.id}/history`),
    graph = executionLayout(task, history.data);
  const [selected, setSelected] = useState(''),
    // The canvas is a camera over the graph: x and y place the graph's top-left corner in the
    // viewport, z is the zoom. Nothing scrolls; dragging and the wheel move the camera.
    [view, setView] = useState<View>({ x: 24, y: 24, z: 1 }),
    [dragging, setDragging] = useState(false),
    canvas = useRef<HTMLDivElement>(null),
    viewRef = useRef(view),
    moved = useRef(false),
    touched = useRef(false);
  viewRef.current = view;
  const active = graph.byId.get(selected) || graph.nodes.filter((n) => n.kind === 'run').at(-1);
  const hasGraph = graph.nodes.length > 0;
  const runs = graph.nodes.filter((n) => n.kind === 'run');
  // Zoom keeping one point of the viewport (the pointer, or the centre) still.
  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const box = size(canvas.current);
    if (!box) return;
    setView((current) => {
      const z = clampZoom(current.z * factor),
        x = px ?? box.width / 2,
        y = py ?? box.height / 2;
      return {
        z,
        x: x - ((x - current.x) * z) / current.z,
        y: y - ((y - current.y) * z) / current.z,
      };
    });
  }, []);
  const fit = useCallback(() => {
    const box = size(canvas.current);
    if (!box || !graph.width) return;
    const z = clampZoom(
      Math.min(1, (box.width - 48) / graph.width, (box.height - 48) / graph.height),
    );
    setView({ z, x: (box.width - graph.width * z) / 2, y: (box.height - graph.height * z) / 2 });
  }, [graph.width, graph.height]);
  // The opening view: the whole graph when it fits at a readable size, otherwise the latest
  // runs at that size with the newest one in view.
  const overview = useCallback(() => {
    const box = size(canvas.current),
      last = graph.nodes.filter((n) => n.kind === 'run').at(-1);
    if (!box || !graph.width) return;
    const whole = Math.min(1, (box.width - 48) / graph.width, (box.height - 48) / graph.height);
    if (whole >= READABLE_ZOOM || !last) return fit();
    const z = Math.min(1, Math.max(READABLE_ZOOM, (box.height - 48) / graph.height));
    setView({
      z,
      x: Math.min(24, box.width - 32 - (last.x + NODE_WIDTH) * z),
      y: Math.max(24, (box.height - graph.height * z) / 2),
    });
  }, [fit, graph.width, graph.height, graph.nodes]);
  const centre = useCallback(
    (id: string) => {
      const node = graph.byId.get(id),
        box = size(canvas.current);
      if (!node || !box) return;
      setView((current) => ({
        ...current,
        x: box.width / 2 - (node.x + NODE_WIDTH / 2) * current.z,
        y: box.height / 2 - (node.y + NODE_HEIGHT / 2) * current.z,
      }));
    },
    [graph.byId],
  );
  // Show the whole graph when it first appears or grows, until the person moves the camera.
  // Until the person moves the camera, keep the opening view right as the canvas settles
  // into its size (a drawer opening, the window resizing).
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let width = element.clientWidth,
      height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width && element.clientHeight === height) return;
      width = element.clientWidth;
      height = element.clientHeight;
      if (!touched.current) overviewRef.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasGraph]);
  useEffect(() => {
    if (!touched.current) overview();
    // Only a new run or layout should move the camera, not every refresh of the same graph.
  }, [graph.nodes.length, graph.width, graph.height]);
  useEffect(() => {
    if (selected) centre(selected);
  }, [selected, centre]);
  // The wheel zooms around the pointer; a sideways trackpad swipe pans. React's wheel handler
  // is passive, so this one is attached by hand to be able to keep the page from scrolling.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      touched.current = true;
      const box = element.getBoundingClientRect(),
        scale = box.width / (element.clientWidth || box.width || 1);
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        setView((current) => ({ ...current, x: current.x - event.deltaX }));
        return;
      }
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(
        Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)),
        (event.clientX - box.left) / scale,
        (event.clientY - box.top) / scale,
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [hasGraph, zoomAt]);
  const graphHeight = Math.min(460, Math.max(260, graph.height + 64));
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
            title="Focus current run"
            disabled={!runs.length}
            onClick={() => {
              const last = runs.at(-1)?.id || '';
              touched.current = true;
              setSelected(last);
              centre(last);
            }}
          >
            <Icon name="search" size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={view.z <= MIN_ZOOM}
            onClick={() => {
              touched.current = true;
              zoomAt(1 / 1.2);
            }}
          >
            <Icon name="minus" size={16} />
          </button>
          <button
            className="text-button graph-zoom"
            aria-label={`Fit graph to view: ${Math.round(view.z * 100)}%`}
            title="Fit to view"
            onClick={() => {
              fit();
              touched.current = true;
            }}
          >
            {Math.round(view.z * 100)}%
          </button>
          <button
            className="icon-button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={view.z >= MAX_ZOOM}
            onClick={() => {
              touched.current = true;
              zoomAt(1.2);
            }}
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
            className={`execution-canvas ${dragging ? 'is-dragging' : ''}`}
            ref={canvas}
            role="application"
            tabIndex={0}
            aria-label="Execution graph. Drag or use the arrow keys to move, scroll or plus and minus to zoom, 0 to fit."
            style={{ height: graphHeight }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              moved.current = false;
              const start = {
                  px: event.clientX,
                  py: event.clientY,
                  x: viewRef.current.x,
                  y: viewRef.current.y,
                },
                element = event.currentTarget,
                pointer = event.pointerId;
              const move = (next: PointerEvent) => {
                const dx = next.clientX - start.px,
                  dy = next.clientY - start.py;
                if (!moved.current && Math.hypot(dx, dy) < 4) return;
                if (!moved.current) {
                  // Past a small threshold this is a drag, not a click on a run.
                  moved.current = touched.current = true;
                  element.setPointerCapture(pointer);
                  setDragging(true);
                }
                setView((current) => ({ ...current, x: start.x + dx, y: start.y + dy }));
              };
              const up = () => {
                element.removeEventListener('pointermove', move);
                element.removeEventListener('pointerup', up);
                element.removeEventListener('pointercancel', up);
                setDragging(false);
              };
              element.addEventListener('pointermove', move);
              element.addEventListener('pointerup', up);
              element.addEventListener('pointercancel', up);
            }}
            onClickCapture={(event) => {
              if (moved.current) {
                event.preventDefault();
                event.stopPropagation();
                moved.current = false;
              }
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const step = event.shiftKey ? 120 : 40,
                pan: Record<string, [number, number]> = {
                  ArrowLeft: [step, 0],
                  ArrowRight: [-step, 0],
                  ArrowUp: [0, step],
                  ArrowDown: [0, -step],
                };
              if (pan[event.key]) {
                const [dx, dy] = pan[event.key]!;
                touched.current = true;
                setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
              } else if (event.key === '+' || event.key === '=') {
                touched.current = true;
                zoomAt(1.2);
              } else if (event.key === '-' || event.key === '_') {
                touched.current = true;
                zoomAt(1 / 1.2);
              } else if (event.key === '0') {
                fit();
                touched.current = true;
              } else return;
              event.preventDefault();
            }}
          >
            <div
              className="execution-world"
              style={{
                width: graph.width,
                height: graph.height,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
              }}
            >
              <div>
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
                      x1 = from.x + NODE_WIDTH,
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
                    style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
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
