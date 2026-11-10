import { useEffect, useRef, useState } from 'react';
import {
  availablePercent,
  formatBytes,
  parsePolicyDraft,
  policyDraft,
  saveStoragePolicy,
  scanStorage,
  type StorageDraft,
  type StorageScan,
} from './storage';
import type { StorageReport } from './storage';
export function StoragePage({
  token,
  report,
  loadError,
  refresh,
}: {
  token: string;
  report: StorageReport | null;
  loadError: string;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<StorageDraft | null>(null),
    [draftRevision, setDraftRevision] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false);
  const field = (
    label: string,
    key: 'warningPercent' | 'criticalPercent' | 'warningGiB' | 'criticalGiB',
    units: string,
  ) => (
    <label className="field">
      {label}
      <div className="number-field">
        <input
          type="number"
          min={0}
          max={units === '%' ? 100 : 8388607}
          step={units === '%' ? 1 : 'any'}
          required
          value={draft?.[key] || ''}
          onChange={(event) =>
            setDraft((current) => (current ? { ...current, [key]: event.target.value } : current))
          }
        />
        <span>{units}</span>
      </div>
    </label>
  );
  const [scans, setScans] = useState<Record<string, StorageScan>>({}),
    [scanning, setScanning] = useState<string | null>(null);
  const scanController = useRef<AbortController | null>(null),
    currentReport = useRef(report),
    mounted = useRef(true);
  currentReport.current = report;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scanController.current?.abort();
    };
  }, []);
  async function inspect(index: number, path: string) {
    if (!report || scanController.current) return;
    const revision = report.revision,
      controller = new AbortController();
    scanController.current = controller;
    setScanning(path);
    setError('');
    try {
      const result = await scanStorage(token, index, revision, controller.signal);
      if (!mounted.current) return;
      if (
        currentReport.current?.revision !== revision ||
        result.revision !== revision ||
        result.path !== path
      ) {
        setError('Storage paths changed. Refresh and inspect again.');
        return;
      }
      setScans((current) => ({ ...current, [path]: result }));
    } catch (failure) {
      if (mounted.current && !(failure instanceof DOMException && failure.name === 'AbortError'))
        setError(failure instanceof Error ? failure.message : 'Could not inspect path.');
    } finally {
      if (scanController.current === controller) scanController.current = null;
      if (mounted.current) setScanning(null);
    }
  }
  const stale = !!report && editing && draftRevision !== report.revision;
  return (
    <section className="storage-page">
      <div className="page-title">
        <div>
          <h1>Storage</h1>
          <p>Monitor free space before it disrupts work.</p>
        </div>
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {(error || loadError) && (
        <p className="error" role="status">
          {error || loadError}
        </p>
      )}
      {!report ? (
        <p role="status">Checking the Relay data volume…</p>
      ) : (
        <>
          <div className={`storage-status storage-${report.pressure.state}`}>
            <div>
              <span className="eyebrow">{report.scope}</span>
              <h2>{formatBytes(report.pressure.space.availableBytes)} free</h2>
              <p>{report.pressure.message}</p>
            </div>
            <strong>
              {report.pressure.state === 'critical'
                ? 'Critical'
                : report.pressure.state === 'warning'
                  ? 'Low space'
                  : report.pressure.state === 'disabled'
                    ? 'Warnings off'
                    : 'Healthy'}
            </strong>
          </div>
          <div
            className="storage-meter"
            role="meter"
            aria-label="Available disk space"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={availablePercent(report.pressure.space)}
            aria-valuetext={`${formatBytes(report.pressure.space.availableBytes)} available of ${formatBytes(report.pressure.space.totalBytes)}`}
          >
            <span
              style={{
                width: `${availablePercent(report.pressure.space)}%`,
              }}
            />
          </div>
          <p className="form-note">
            {formatBytes(report.pressure.space.totalBytes)} total · This checks the Relay data
            volume; repository workspaces can be on other volumes.
          </p>
          <section className="storage-card">
            <div className="page-title">
              <div>
                <h2>Warning thresholds</h2>
                <p>
                  The percentage or the minimum free space, whichever is higher, determines each
                  threshold.
                </p>
              </div>
              {!editing && (
                <button
                  onClick={() => {
                    setDraft(policyDraft(report.policy));
                    setDraftRevision(report.revision);
                    setEditing(true);
                    setError('');
                  }}
                >
                  Edit thresholds
                </button>
              )}
            </div>
            {editing && draft ? (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  setError('');
                  try {
                    const policy = parsePolicyDraft(draft);
                    setBusy(true);
                    await saveStoragePolicy(token, draftRevision, policy);
                    setEditing(false);
                    setDraft(null);
                    await refresh();
                  } catch (failure) {
                    setError(
                      failure instanceof Error ? failure.message : 'Could not save storage policy.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                  Enable storage warnings
                </label>
                {stale && (
                  <p role="status" className="error">
                    The policy changed while you were editing. Cancel and reopen it to review the
                    latest values.
                  </p>
                )}
                <div className="storage-fields">
                  {field('Warn below', 'warningPercent', '%')}
                  {field('Critical below', 'criticalPercent', '%')}
                  {field('Minimum warning space', 'warningGiB', 'GiB')}
                  {field('Minimum critical space', 'criticalGiB', 'GiB')}
                </div>
                <label className="field">
                  Additional paths to monitor
                  <textarea
                    rows={4}
                    value={draft.monitoredPaths}
                    onChange={(event) => setDraft({ ...draft, monitoredPaths: event.target.value })}
                    placeholder="One absolute path per line"
                  />
                  <span className="form-note">
                    For external build or cache directories. Once execution is ported, every listed
                    volume is checked before new work. Missing paths will block that work. Relay
                    never deletes these paths automatically.
                  </span>
                </label>
                <div className="inline-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setDraft(null);
                      setError('');
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="primary" disabled={busy || stale}>
                    {busy ? 'Saving…' : 'Save thresholds'}
                  </button>
                </div>
              </form>
            ) : (
              <dl>
                <div>
                  <dt>Warning</dt>
                  <dd>
                    {report.policy.warningPercent}% or {formatBytes(report.policy.warningBytes)}{' '}
                    free
                  </dd>
                </div>
                <div>
                  <dt>Critical</dt>
                  <dd>
                    {report.policy.criticalPercent}% or {formatBytes(report.policy.criticalBytes)}{' '}
                    free
                  </dd>
                </div>
                {report.policy.monitoredPaths.length > 0 && (
                  <div>
                    <dt>Additional paths</dt>
                    <dd>
                      {report.policy.monitoredPaths.map((path) => (
                        <code key={path}>
                          {path}
                          <br />
                        </code>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </section>
          {report.policy.monitoredPaths.length > 0 && (
            <section className="storage-card">
              <h2>Monitored paths</h2>
              <p>Inspect a path to see its allocated size. Scans are read-only and bounded.</p>
              <ul className="storage-paths">
                {report.policy.monitoredPaths.map((path, index) => {
                  const result =
                    scans[path]?.revision === report.revision ? scans[path] : undefined;
                  return (
                    <li key={path}>
                      <div>
                        <code>{path}</code>
                        <button
                          type="button"
                          disabled={!!scanning}
                          onClick={() => void inspect(index, path)}
                        >
                          {scanning === path ? 'Inspecting…' : 'Inspect'}
                        </button>
                      </div>
                      {result && (
                        <p>
                          <strong>
                            {formatBytes(result.scan.allocatedBytes)} estimated allocated
                          </strong>{' '}
                          · {result.scan.files} files
                          {!result.scan.complete
                            ? ` · Partial: ${result.scan.reason || 'scan limited'}`
                            : ''}
                          {result.scan.skippedSymlinks
                            ? ` · ${result.scan.skippedSymlinks} symlinks skipped`
                            : ''}
                          {result.scan.skippedHardlinks
                            ? ` · ${result.scan.skippedHardlinks} hard links deduplicated`
                            : ''}
                          {result.pressure
                            ? ` · ${formatBytes(result.pressure.space.availableBytes)} free on volume`
                            : result.spaceError
                              ? ` · ${result.spaceError}`
                              : ''}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <section className="storage-card">
            <h2>Cleanup</h2>
            <p>
              Relay must only clean caches it owns and can prove are inactive. External build caches
              and worktrees are never removed automatically.
            </p>
            <p className="form-note">
              Critical space blocks new workspace and agent work. Running processes keep their workspace. Cleanup requires a separate action.
            </p>
          </section>
        </>
      )}
    </section>
  );
}
