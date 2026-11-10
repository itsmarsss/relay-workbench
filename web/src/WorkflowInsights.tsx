import { useEffect, useState } from 'react';
import { Markdown } from './Markdown';
import { Select } from './UI';
import { Notice, useResource } from './Session';
import { asObject, asText, externalURL } from './task-data';
import type { FullTask } from './TaskExtras';
import type { RelayConfig } from './types';
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
}
export function WorkflowStatus({ task }: { task: FullTask }) {
  const [now, setNow] = useState(Date.now);
  const run = task.currentRun,
    evidence = asObject(task.health),
    active =
      run?.status === 'running' &&
      (run.auxiliary === true || task.status === 'running' || task.status === 'queued'),
    health = (active ? evidence?.attemptId === run?.id : evidence?.state === task.status)
      ? evidence
      : null;
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active, run?.id]);
  if (!active && !health?.summary) return null;
  const started = Date.parse(asText(asObject(run)?.startedAt)),
    last = Date.parse(asText(health?.lastAt));
  return (
    <div className={`workflow-status ${health?.quiet ? 'is-quiet' : ''}`} role="status">
      <div>
        <strong>
          {active
            ? run?.role === 'debug'
              ? 'Debugger'
              : asText(run?.stage).replaceAll('_', ' ')
            : asText(health?.summary)}
        </strong>
        {active && (
          <span>
            {run?.harness} · {run?.actualModel || run?.model || 'CLI default'}
          </span>
        )}
      </div>
      {active && (
        <>
          <p>{asText(health?.summary) || 'Waiting for first output'}</p>
          <span className="workflow-clock">
            {Number.isFinite(started) && `${duration(now - started)} elapsed`}
            {Number.isFinite(last) && ` · last progress ${duration(now - last)} ago`}
          </span>
        </>
      )}
    </div>
  );
}
export function TaskResult({ task }: { task: FullTask }) {
  const attempts = (Array.isArray(task.attempts) ? task.attempts : []).map(asObject);
  const latest = [...attempts].reverse().find((run) => run?.handoff);
  const handoff = asObject(latest?.handoff);
  const entries = (
    Array.isArray(task.repositories) && task.repositories.length ? task.repositories : [task]
  ).map(asObject);
  const findStage = (stage: string) =>
    [...attempts].reverse().find((run) => run?.stage === stage && run.role !== 'debug');
  const verify = findStage('verify'),
    review = findStage('review');
  return (
    <>
      {handoff && (
        <section className="surface result-brief">
          <div className="section-heading">
            <h2>Latest result</h2>
            <span className="muted">{asText(latest?.stage)}</span>
          </div>
          <Markdown text={asText(handoff.summary)} />
          {(!!verify || !!review || !!task.chosenApproach) && (
            <div className="result-evidence">
              <span>Checks · {asText(verify?.status) || 'Pending'}</span>
              <span>Review · {asText(review?.status) || 'Pending'}</span>
            </div>
          )}
          {!!(Array.isArray(handoff.risks) && handoff.risks.length) && (
            <details>
              <summary>Risks</summary>
              <ul>
                {handoff.risks.map((risk, i) => (
                  <li key={i}>
                    <Markdown text={asText(risk)} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {entries.length > 1 && (
        <section className="surface">
          <h2>Repository coordination</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Repository</th>
                  <th>Prerequisites</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => {
                  const repo = asObject(entry?.repository),
                    deps = (Array.isArray(task.dependencies) ? task.dependencies : [])
                      .map(asObject)
                      .filter((edge) => edge?.repositoryId === repo?.id)
                      .map((edge) =>
                        entries.find(
                          (candidate) => asObject(candidate?.repository)?.id === edge?.dependsOn,
                        ),
                      )
                      .map((candidate) => asText(asObject(candidate?.repository)?.name));
                  const pr = asObject(entry?.publication),
                    url = externalURL(pr?.url);
                  return (
                    <tr key={asText(repo?.id)}>
                      <td>{index + 1}</td>
                      <td>{asText(repo?.name)}</td>
                      <td>{deps.join(', ') || 'None'}</td>
                      <td>
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer">
                            {asText(pr?.state) || 'Pull request'}
                          </a>
                        ) : (
                          'Unpublished'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="form-note">
            Implementation and publication follow prerequisite order. An open pull request still
            needs to be merged separately.
          </p>
        </section>
      )}
    </>
  );
}
type Outcome = {
  stage: string;
  harness: string;
  model: string | null;
  settled: number;
  successful: number;
  pending: number;
  interrupted: number;
  reviewFindings: number;
  medianMs: number | null;
  eligible: boolean;
};
type Outcomes = {
  rows: Outcome[];
  recommendations: { stage: string; harness: string; model: string; samples: number }[];
};
export function RoutingEvidence({
  config,
  onApply,
}: {
  config: RelayConfig;
  onApply: (stage: string, provider: string) => void;
}) {
  const [repository, setRepository] = useState('');
  const data = useResource<Outcomes>(
    '/api/outcomes' + (repository ? '?repositoryId=' + encodeURIComponent(repository) : ''),
  );
  return (
    <details className="routing-evidence">
      <summary>Routing evidence</summary>
      <p className="form-note">
        Observed results from real runs. Recommendations require three settled runs across two tasks
        with the currently configured model.
      </p>
      <Select
        label="Evidence repository"
        value={repository}
        onChange={setRepository}
        options={[
          { value: '', label: 'All repositories' },
          ...config.repositories.map((repo) => ({ value: repo.id, label: repo.name })),
        ]}
      />
      {data.error && <Notice>{data.error}</Notice>}
      {!data.data?.rows.length ? (
        <p className="placeholder">
          {data.loading
            ? 'Loading evidence…'
            : 'Run workflows to collect evidence. No routing changes are automatic.'}
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Agent / model</th>
                  <th>Usable results</th>
                  <th>Median time</th>
                  <th>Findings</th>
                </tr>
              </thead>
              <tbody>
                {data.data.rows.map((row, index) => (
                  <tr key={index}>
                    <td>{row.stage}</td>
                    <td>
                      {row.harness}
                      <small>{row.model || 'Model not recorded'}</small>
                    </td>
                    <td>
                      {row.successful} / {row.settled}
                      <small>
                        {row.pending ? `${row.pending} pending` : ''}
                        {row.interrupted ? ` · ${row.interrupted} interrupted` : ''}
                      </small>
                    </td>
                    <td>{row.medianMs === null ? '—' : duration(row.medianMs)}</td>
                    <td>{row.reviewFindings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.data.recommendations.map((rec) => (
            <div className="routing-recommendation" key={rec.stage}>
              <span>
                {rec.stage} · {rec.harness} · {rec.samples} settled runs
              </span>
              <button type="button" onClick={() => onApply(rec.stage, rec.harness)}>
                Use for {rec.stage}
              </button>
            </div>
          ))}
          <p className="form-note">
            Task difficulty and check/review strictness affect these results. Finding defects is a
            usable review. Save settings to apply a recommendation.
          </p>
        </>
      )}
    </details>
  );
}
