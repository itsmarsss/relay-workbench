import { ApiError } from './api.ts';
export type StoragePolicy = {
  enabled: boolean;
  warningPercent: number;
  criticalPercent: number;
  warningBytes: number;
  criticalBytes: number;
  monitoredPaths: string[];
};
export type StorageReport = {
  policy: StoragePolicy;
  revision: string;
  scope: string;
  admissionEnforced: boolean;
  automaticCleanup: boolean;
  pressure: {
    state: 'disabled' | 'normal' | 'warning' | 'critical';
    message: string;
    warningThreshold: string;
    criticalThreshold: string;
    space: { totalBytes: string; availableBytes: string };
  };
};
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function isStoragePolicy(value: unknown): value is StoragePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.enabled === 'boolean' &&
    integer(p.warningPercent) &&
    integer(p.criticalPercent) &&
    integer(p.warningBytes) &&
    integer(p.criticalBytes) &&
    p.warningPercent <= 100 &&
    p.criticalPercent <= p.warningPercent &&
    p.criticalBytes <= p.warningBytes &&
    Array.isArray(p.monitoredPaths) &&
    p.monitoredPaths.length <= 20 &&
    p.monitoredPaths.every(
      (path) =>
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= 2000 &&
        !/[\0\r\n]/.test(path),
    )
  );
}
const maxUint64 = (1n << 64n) - 1n;
function uintString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  return BigInt(value) <= maxUint64;
}
function isPressure(value: unknown): value is StorageReport['pressure'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (
    !['disabled', 'normal', 'warning', 'critical'].includes(String(p.state)) ||
    typeof p.message !== 'string' ||
    !uintString(p.warningThreshold) ||
    !uintString(p.criticalThreshold) ||
    !p.space ||
    typeof p.space !== 'object' ||
    Array.isArray(p.space)
  )
    return false;
  const space = p.space as Record<string, unknown>;
  return (
    uintString(space.totalBytes) &&
    BigInt(space.totalBytes) > 0n &&
    uintString(space.availableBytes) &&
    BigInt(space.availableBytes) <= BigInt(space.totalBytes)
  );
}
function isReport(value: unknown): value is StorageReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    isStoragePolicy(r.policy) &&
    typeof r.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(r.revision) &&
    typeof r.scope === 'string' &&
    typeof r.admissionEnforced === 'boolean' &&
    typeof r.automaticCleanup === 'boolean' &&
    isPressure(r.pressure)
  );
}

async function read(response: Response): Promise<unknown> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiError('Relay returned an invalid response.', response.status);
  }
  if (!response.ok) {
    const msg =
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `Request failed (${response.status}).`;
    throw new ApiError(msg, response.status);
  }
  return result;
}
export async function fetchStorage(signal?: AbortSignal): Promise<StorageReport> {
  const result = await read(
    await fetch('/api/storage/pressure', { signal, headers: { Accept: 'application/json' } }),
  );
  if (!isReport(result)) throw new Error('Storage report is invalid.');
  return result;
}
export async function saveStoragePolicy(
  token: string,
  revision: string,
  policy: StoragePolicy,
): Promise<void> {
  if (!isStoragePolicy(policy)) throw new Error('Check the warning and critical thresholds.');
  await read(
    await fetch('/api/storage/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token, 'If-Match': revision },
      body: JSON.stringify(policy),
    }),
  );
}
export function formatBytes(value: number | string | bigint): string {
  const bytes = typeof value === 'bigint' ? value : BigInt(value);
  if (bytes < 1024n) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let scale = 1024n,
    index = 0;
  while (bytes >= scale * 1024n && index < units.length - 1) {
    scale *= 1024n;
    index++;
  }
  const tenths = (bytes * 10n + scale / 2n) / scale;
  return `${tenths / 10n}${tenths / 10n < 100n ? '.' + (tenths % 10n) : ''} ${units[index]}`;
}
export function availablePercent(space: StorageReport['pressure']['space']): number {
  return Number((BigInt(space.availableBytes) * 10000n) / BigInt(space.totalBytes)) / 100;
}

export type StorageDraft = {
  enabled: boolean;
  warningPercent: string;
  criticalPercent: string;
  warningGiB: string;
  criticalGiB: string;
  monitoredPaths: string;
};
const gib = 1024 ** 3;
export function policyDraft(policy: StoragePolicy): StorageDraft {
  return {
    enabled: policy.enabled,
    warningPercent: String(policy.warningPercent),
    criticalPercent: String(policy.criticalPercent),
    warningGiB: String(policy.warningBytes / gib),
    criticalGiB: String(policy.criticalBytes / gib),
    monitoredPaths: policy.monitoredPaths.join('\n'),
  };
}
export function parsePolicyDraft(draft: StorageDraft): StoragePolicy {
  const parse = (value: string) => {
    if (!value.trim()) throw new Error('Enter every storage threshold.');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0)
      throw new Error('Storage thresholds must be nonnegative numbers.');
    return n;
  };
  const warningPercent = parse(draft.warningPercent),
    criticalPercent = parse(draft.criticalPercent),
    warningBytes = Math.round(parse(draft.warningGiB) * gib),
    criticalBytes = Math.round(parse(draft.criticalGiB) * gib);
  const policy = {
    enabled: draft.enabled,
    warningPercent,
    criticalPercent,
    warningBytes,
    criticalBytes,
    monitoredPaths: draft.monitoredPaths.split('\n').filter((path) => path.trim() !== ''),
  };
  if (!isStoragePolicy(policy))
    throw new Error(
      'Critical thresholds must not exceed warning thresholds; percentages must be whole numbers.',
    );
  return policy;
}
export type StorageScan = {
  path: string;
  revision: string;
  scan: {
    allocatedBytes: string;
    logicalBytes: string;
    files: number;
    directories: number;
    skippedSymlinks: number;
    skippedHardlinks: number;
    skippedMounts: number;
    complete: boolean;
    reason?: string;
  };
  pressure?: StorageReport['pressure'];
  spaceError?: string;
};
function isScan(value: unknown): value is StorageScan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (
    typeof result.path !== 'string' ||
    typeof result.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.revision) ||
    !result.scan ||
    typeof result.scan !== 'object' ||
    Array.isArray(result.scan)
  )
    return false;
  if (result.pressure !== undefined && !isPressure(result.pressure)) return false;
  if (result.spaceError !== undefined && typeof result.spaceError !== 'string') return false;
  const scan = result.scan as Record<string, unknown>;
  return (
    uintString(scan.allocatedBytes) &&
    uintString(scan.logicalBytes) &&
    integer(scan.files) &&
    integer(scan.directories) &&
    integer(scan.skippedSymlinks) &&
    integer(scan.skippedHardlinks) &&
    integer(scan.skippedMounts) &&
    typeof scan.complete === 'boolean' &&
    (scan.reason === undefined || typeof scan.reason === 'string')
  );
}
export async function scanStorage(
  token: string,
  index: number,
  revision: string,
  signal?: AbortSignal,
): Promise<StorageScan> {
  const query = new URLSearchParams({ index: String(index), revision });
  const result = await read(
    await fetch(`/api/storage/scan?${query}`, {
      signal,
      headers: { Accept: 'application/json', 'X-Relay-Token': token },
    }),
  );
  if (!isScan(result)) throw new Error('Storage scan is invalid.');
  return result;
}
