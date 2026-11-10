import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { CopyButton, Select } from './UI';
import { Notice, request, useResource } from './Session';
import { asObject, asText } from './task-data';
import type { FullTask } from './TaskExtras';
import { activityEntries, activityWindow } from './activity-window';

type Row = Record<string, unknown> & { seq: number };
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error('Invalid activity response');
  return value.map((item) => {
    const row = asObject(item);
    if (!row || !Number.isSafeInteger(row.seq)) throw new Error('Invalid activity cursor');
    return row as Row;
  });
}
function label(value: unknown) {
  return asText(value).replaceAll('_', ' ') || 'Update';
}
function when(value: unknown) {
  const date = new Date(asText(value));
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
}
function Strings({ title, value }: { title: string; value: unknown }) {
  if (!Array.isArray(value) || !value.length) return null;
  return (
    <section>
      <h4>{title}</h4>
      <ul>
        {value.slice(0, 100).map((item, index) => (
          <li key={index}>
            <Markdown text={asText(item)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
export function HandoffDetails({ value }: { value: unknown }) {
  const handoff = asObject(value);
  if (!handoff) return null;
  const findings = Array.isArray(handoff.findings) ? handoff.findings : [];
  return (
    <div className="handoff-details">
      <Markdown text={asText(handoff.details, 100000)} />
      <Strings title="Files" value={handoff.files} />
      <Strings title="Evidence" value={handoff.evidence} />
      <Strings title="Risks" value={handoff.risks} />
      {!!findings.length && (
        <section>
          <h4>Findings</h4>
          {findings.map((item, index) => {
            const finding = asObject(item);
            return (
              <article key={index} className="finding">
                <strong>
                  {label(finding?.severity)} · {asText(finding?.file)}
                </strong>
                <Markdown text={asText(finding?.description)} />
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
export function HandoffsPanel({ taskId }: { taskId: string }) {
  const resource = useResource<FullTask>(`/api/tasks/${taskId}`),
    task = resource.data;
  const runs = [
    ...(Array.isArray(task?.attempts) ? task.attempts : []),
    ...(Array.isArray(task?.deliveryRuns) ? task.deliveryRuns : []),
  ]
    .map(asObject)
    .filter((row) => row && row.stage !== 'monitor' && (row.handoff || row.error))
    .reverse();
  return (
    <div className="pane-content rich-handoffs">
      {resource.error && <Notice>{resource.error}</Notice>}
      {!runs.length && (
        <p className="placeholder">{resource.loading ? 'Loading handoffs…' : 'No handoffs yet.'}</p>
      )}
      {runs.map((row, index) => (
        <article className="handoff-card" key={asText(row?.id) || index}>
          <header>
            <span className="eyebrow">
              {row?.role === 'debug' ? 'Debugger' : label(row?.stage)}
            </span>
            <span className="muted">
              {asText(row?.harness)} · {label(row?.status)} · {when(row?.finishedAt)}
            </span>
          </header>
          <Markdown text={asText(asObject(row?.handoff)?.summary || row?.error)} />
          <details>
            <summary>Evidence and details</summary>
            <HandoffDetails value={row?.handoff} />
            {!!row?.error && <Markdown text={asText(row.error)} />}
            <Strings
              title="Verification evidence"
              value={
                Array.isArray(row?.verificationEvidence)
                  ? row.verificationEvidence.map((item) => JSON.stringify(item, null, 2))
                  : []
              }
            />
          </details>
        </article>
      ))}
    </div>
  );
}
export function ActivityPanel({ taskId, logs = false }: { taskId: string; logs?: boolean }) {
  const [events, setEvents] = useState<Row[]>([]),
    [error, setError] = useState(''),
    [older, setOlder] = useState(false),
    [loading, setLoading] = useState(true),
    [stage, setStage] = useState(''),
    [all, setAll] = useState(false),
    [historical, setHistorical] = useState(false),
    [refresh, setRefresh] = useState(0);
  const state = useRef({ first: 0, last: 0, busy: false, taskId, rows: [] as Row[] }),
    scroll = useRef<HTMLDivElement>(null),
    following = useRef(true),
    browsing = useRef(false);
  useEffect(() => {
    let alive = true,
      again = false;
    const controller = new AbortController();
    const cursor = { first: 0, last: 0, busy: false, taskId, rows: [] as Row[] };
    state.current = cursor;
    setEvents([]);
    setLoading(true);
    setError('');
    setStage('');
    setOlder(false);
    setHistorical(false);
    browsing.current = false;
    following.current = true;
    async function load() {
      if (browsing.current) return;
      if (cursor.busy) {
        again = true;
        return;
      }
      cursor.busy = true;
      try {
        const initial = !cursor.last;
        const result = rows(
          await request(
            `/api/tasks/${taskId}/events?${initial ? 'before=0' : 'after=' + cursor.last}`,
            undefined,
            undefined,
            'GET',
            controller.signal,
          ),
        );
        if (alive) {
          if (initial) setOlder(result.length === 200);
          if (result.length) {
            const next = activityWindow(cursor.rows, result, 'later');
            cursor.first = next.first;
            cursor.last = next.last;
            cursor.rows = next.rows;
            if (next.trimmed) setOlder(true);
            setEvents(next.rows);
            if (result.length === 200) again = true;
          }
          setError('');
        }
      } catch (e) {
        if (alive && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Could not load activity');
      } finally {
        cursor.busy = false;
        if (alive) {
          setLoading(false);
          if (again) {
            again = false;
            void load();
          }
        }
      }
    }
    const changed = () => {
      void load();
    };
    void load();
    window.addEventListener('relay-data-change', changed);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 4000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('relay-data-change', changed);
    };
  }, [taskId, refresh]);
  useEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [events, logs, stage, all]);
  async function previous() {
    const cursor = state.current;
    if (cursor.busy || cursor.taskId !== taskId) return;
    cursor.busy = true;
    browsing.current = true;
    setHistorical(true);
    following.current = false;
    const el = scroll.current,
      height = el?.scrollHeight || 0,
      top = el?.scrollTop || 0;
    try {
      const result = rows(await request(`/api/tasks/${taskId}/events?before=${cursor.first}`));
      if (state.current !== cursor) return;
      setOlder(result.length === 200);
      if (result.length) {
        const next = activityWindow(cursor.rows, result, 'earlier');
        cursor.first = next.first;
        cursor.last = next.last;
        cursor.rows = next.rows;
        setEvents(next.rows);
      }
      following.current = false;
      requestAnimationFrame(() => {
        if (state.current === cursor && el) el.scrollTop = top + el.scrollHeight - height;
      });
    } catch (e) {
      if (state.current === cursor)
        setError(e instanceof Error ? e.message : 'Could not load older activity');
    } finally {
      cursor.busy = false;
    }
  }
  const stages = [...new Set(events.map((row) => asText(row.stage)).filter(Boolean))];
  const visible = activityEntries(events).filter(
    (row) =>
      (logs
        ? row.type === 'transcript'
        : row.type !== 'transcript' &&
          (all || row.stage !== 'monitor' || row.observationChange === true)) &&
      (!stage || row.stage === stage),
  );
  return (
    <div className="pane-content activity-panel">
      <div className="activity-toolbar">
        <Select
          label="Filter activity stage"
          value={stage}
          options={[
            { value: '', label: 'All stages' },
            ...stages.map((value) => ({ value, label: label(value) })),
          ]}
          onChange={setStage}
        />
        {!logs && (
          <button aria-pressed={all} onClick={() => setAll(!all)}>
            Include PR polling
          </button>
        )}
        <CopyButton
          text={visible.map((row) => asText(row.summary || row.text || row.details)).join('\n\n')}
        />
        {historical && (
          <button onClick={() => setRefresh((value) => value + 1)}>Jump to latest</button>
        )}
      </div>
      {historical && (
        <p className="form-note">Viewing earlier activity. Live updates are paused.</p>
      )}
      {error && <Notice>{error}</Notice>}
      <div
        className="activity-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label={logs ? 'Execution logs' : 'Task activity'}
        onScroll={() => {
          const el = scroll.current;
          if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {older && (
          <button className="load-older" onClick={() => void previous()}>
            Load earlier activity
          </button>
        )}
        {!visible.length && (
          <p className="placeholder">
            {loading ? 'Loading activity…' : logs ? 'No execution output yet.' : 'No activity yet.'}
          </p>
        )}
        <ol className="activity-list">
          {visible.map((row) => {
            const text = asText(row.summary || row.activity || row.message || row.text, 50000),
              detail = asText(row.details, 100000),
              passoff = row.type === 'handoff',
              tool = row.kind === 'tool';
            return (
              <li key={row.seq} className={`activity-entry ${passoff ? 'is-handoff' : ''}`}>
                <div className="activity-entry-meta">
                  <span className="activity-kind">
                    {passoff ? 'Handoff' : label(row.kind || row.type)}
                  </span>
                  {!!row.stage && (
                    <span>{row.role === 'debug' ? 'Debugger' : label(row.stage)}</span>
                  )}
                  {!!row.harness && <span>{asText(row.harness)}</span>}
                  <time dateTime={asText(row.at || row.timestamp)}>
                    {when(row.at || row.timestamp)}
                  </time>
                </div>
                {logs || tool ? <pre>{text || detail}</pre> : <Markdown text={text || detail} />}{' '}
                {!!text && !!detail && text !== detail && !logs && (
                  <details>
                    <summary>Details</summary>
                    {tool ? <pre>{detail}</pre> : <Markdown text={detail} />}
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
