export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'awaiting_plan'
  | 'awaiting_final'
  | 'completed'
  | 'paused'
  | 'manual'
  | 'blocked'
  | 'interrupted'
  | 'cancelled'
  | string;
export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  stage?: string;
  repository?: { id: string; name: string };
  currentRun?: {
    auxiliary?: boolean;
    id: string;
    stage?: string;
    harness?: string;
    role?: string;
    status?: string;
    model?: string;
    actualModel?: string;
  };
  latestSummary?: string;
  error?: string | null;
  updatedAt?: string;
  taskRevision?: string;
  ticket?: string;
  statusOverride?: { value: string; lane?: string } | null;
  repositories?: { repository?: { id: string; name: string } }[];
};
export type TaskView = 'overview' | 'thread' | 'terminals' | 'diff' | 'handoffs' | 'transcript';
export const taskViews: { id: TaskView; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'thread', label: 'Activity' },
  { id: 'terminals', label: 'Terminal' },
  { id: 'diff', label: 'Changes' },
  { id: 'handoffs', label: 'Handoffs' },
  { id: 'transcript', label: 'Logs' },
];
export const statusLabel = (status: TaskStatus): string =>
  ({
    draft: 'Backlog',
    imported: 'Imported history',
    queued: 'Queued',
    running: 'In progress',
    awaiting_plan: 'Choose an approach',
    awaiting_final: 'Final approval',
    completed: 'Done',
    finished: 'Completed',
    paused: 'Paused',
    manual: 'Manual control',
    blocked: 'Needs attention',
    interrupted: 'Interrupted',
    cancelled: 'Cancelled',
  })[status] ?? status;
export function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(record.id) ||
    typeof record.title !== 'string' ||
    typeof record.status !== 'string'
  )
    return false;
  for (const key of ['stage', 'latestSummary', 'updatedAt'])
    if (record[key] != null && typeof record[key] !== 'string') return false;
  if (record.error != null && typeof record.error !== 'string') return false;
  if (
    record.taskRevision != null &&
    (typeof record.taskRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.taskRevision))
  )
    return false;
  if (record.repository != null) {
    if (typeof record.repository !== 'object' || Array.isArray(record.repository)) return false;
    const repo = record.repository as Record<string, unknown>;
    if (typeof repo.id !== 'string' || typeof repo.name !== 'string') return false;
  }
  if (record.currentRun != null) {
    if (typeof record.currentRun !== 'object' || Array.isArray(record.currentRun)) return false;
    const run = record.currentRun as Record<string, unknown>;
    if (typeof run.id !== 'string') return false;
    for (const key of ['stage', 'harness', 'role', 'status', 'model', 'actualModel'])
      if (run[key] != null && typeof run[key] !== 'string') return false;
  }
  return true;
}

export type RepositoryProfile = {
  id: string;
  name: string;
  path: string;
  cwd: string;
  strategy: 'worktree' | 'managed' | 'attach';
  verificationMode: 'agent' | 'commands';
  checks: { command: string; args: string[] }[];
  setup: { command: string; args: string[] }[];
  instructions: string;
  [key: string]: unknown;
};
export type RelayConfig = Record<string, unknown> & { repositories: RepositoryProfile[] };
export type Bootstrap = {
  token: string;
  config: RelayConfig;
  configRevision: string;
  workflowPreview: boolean;
  implementationPreview: boolean;
  debugRecoveryPreview: boolean;
  issueImportPreview: boolean;
};
export type ImportedIssue = {
  title: string;
  description: string;
  ticket: string;
  warnings: string[];
};
export function isConfig(value: unknown): value is RelayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    Array.isArray(config.repositories) &&
    config.repositories.every((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const repo = item as Record<string, unknown>;
      return (
        typeof repo.id === 'string' &&
        typeof repo.name === 'string' &&
        typeof repo.path === 'string' &&
        typeof repo.cwd === 'string' &&
        ['worktree', 'managed', 'attach'].includes(String(repo.strategy)) &&
        ['agent', 'commands'].includes(String(repo.verificationMode)) &&
        Array.isArray(repo.checks) &&
        Array.isArray(repo.setup) &&
        typeof repo.instructions === 'string'
      );
    })
  );
}
