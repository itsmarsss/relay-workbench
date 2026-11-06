import { isAbsolute, normalize, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

export const STAGES = ['triage', 'investigate', 'plan', 'implement', 'verify', 'review'];
export const HARNESSES = ['codex', 'claude', 'pi'];
export const DEFAULT_CONFIG = {
  concurrency: 2,
  maxRepairRounds: 3,
  maxRecoveryAttempts: 2,
  timeoutMinutes: 60,
  routing: {
    triage: 'pi',
    investigate: 'codex',
    plan: 'claude',
    implement: 'codex',
    review: 'claude',
  },
  harnesses: {
    codex: { command: 'codex', model: '', enabled: true },
    claude: { command: 'claude', model: '', enabled: true },
    pi: { command: 'pi', model: '', enabled: true },
  },
  repositories: [],
};

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw new InputError(message, status);
}
export function text(value, label, max = 20000, optional = false) {
  requireValue(
    typeof value === 'string' && value.length <= max && (optional || value.trim().length > 0),
    `${label} must be ${optional ? 'a' : 'a nonempty'} string of at most ${max} characters`,
  );
  return value.trim();
}
export function command(value) {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'Command must be an object',
  );
  return {
    command: text(value.command, 'Executable', 1000),
    args: (() => {
      requireValue(
        Array.isArray(value.args) &&
          value.args.length <= 100 &&
          value.args.every((a) => typeof a === 'string' && a.length < 20000),
        'Command args must be an array of strings',
      );
      return value.args;
    })(),
  };
}
export function validateConfig(raw) {
  requireValue(raw && typeof raw === 'object', 'Configuration must be an object');
  const c = structuredClone(DEFAULT_CONFIG);
  for (const [key, min, max] of [
    ['concurrency', 1, 8],
    ['maxRepairRounds', 1, 10],
    ['maxRecoveryAttempts', 0, 5],
    ['timeoutMinutes', 1, 240],
  ]) {
    c[key] = raw[key] ?? c[key];
    requireValue(
      Number.isInteger(c[key]) && c[key] >= min && c[key] <= max,
      `${key} must be between ${min} and ${max}`,
    );
  }
  for (const id of HARNESSES) {
    const h = raw.harnesses?.[id] ?? c.harnesses[id];
    c.harnesses[id] = {
      command: text(h.command, 'Executable', 1000),
      model: text(h.model ?? '', 'Model', 200, true),
      enabled: h.enabled !== false,
    };
  }
  for (const stage of Object.keys(c.routing)) {
    const id = raw.routing?.[stage] ?? c.routing[stage];
    requireValue(HARNESSES.includes(id), `Unknown harness for ${stage}`);
    c.routing[stage] = id;
  }
  requireValue(
    Array.isArray(raw.repositories ?? []) && (raw.repositories ?? []).length <= 100,
    'Repositories must be an array of at most 100 profiles',
  );
  c.repositories = (raw.repositories ?? []).map((r) => {
    requireValue(r && typeof r === 'object', 'Invalid repository profile');
    const strategy = r.strategy ?? 'worktree';
    requireValue(
      ['worktree', 'managed', 'attach'].includes(strategy),
      'Unknown workspace strategy',
    );
    requireValue(
      strategy !== 'managed' || r.workspaceCommand,
      'Managed workspaces require a creation command',
    );
    const checks = (r.checks ?? []).map(command);
    const setup = (r.setup ?? []).map(command);
    requireValue(checks.length <= 30 && setup.length <= 30, 'Too many commands');
    const access = r.developmentAccess ?? {};
    requireValue(
      access && typeof access === 'object' && !Array.isArray(access),
      'Invalid development access',
    );
    for (const key of ['analysisCommands', 'networkAccess'])
      requireValue(access[key] === undefined || typeof access[key] === 'boolean', `Invalid ${key}`);
    const writableRoots = access.writableRoots ?? [];
    requireValue(
      Array.isArray(writableRoots) &&
        writableRoots.length <= 20 &&
        writableRoots.every(
          (path) =>
            typeof path === 'string' &&
            isAbsolute(path) &&
            normalize(path) !== parse(path).root &&
            path.length <= 2000 &&
            !path.split('/').includes('..'),
        ),
      'Writable roots must be explicit absolute directories',
    );
    return {
      developmentAccess: {
        analysisCommands: access.analysisCommands === true,
        networkAccess: access.networkAccess === true,
        writableRoots,
      },
      id: r.id ? text(r.id, 'Repository ID', 100) : randomUUID(),
      name: text(r.name, 'Repository name', 100),
      path: text(r.path, 'Repository path', 2000),
      cwd: text(r.cwd ?? '.', 'Working subdirectory', 2000),
      strategy,
      workspaceCommand: r.workspaceCommand ? command(r.workspaceCommand) : null,
      workspacePath:
        strategy === 'managed'
          ? text(r.workspacePath, 'Managed workspace path template', 2000)
          : '',
      checks,
      setup,
      instructions: text(r.instructions ?? '', 'Instructions', 50000, true),
      issueCommand: r.issueCommand ? command(r.issueCommand) : null,
      prCommand: r.prCommand ? command(r.prCommand) : null,
    };
  });
  requireValue(
    new Set(c.repositories.map((r) => r.id)).size === c.repositories.length,
    'Duplicate repository IDs',
  );
  return c;
}

const stringList = { type: 'array', items: { type: 'string' } };
export const HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    details: { type: 'string' },
    files: stringList,
    evidence: stringList,
    risks: stringList,
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tradeoffs: { type: 'string' },
        },
        required: ['id', 'title', 'description', 'tradeoffs'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['severity', 'file', 'description'],
      },
    },
    verdict: {
      type: 'string',
      enum: [
        'complete',
        'changes_requested',
        'blocked',
        'repair_requested',
        'verification_requested',
      ],
    },
    routing: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        ['investigate', 'plan', 'implement', 'review'].map((s) => [
          s,
          { type: 'string', enum: HARNESSES },
        ]),
      ),
      required: ['investigate', 'plan', 'implement', 'review'],
    },
  },
  required: [
    'summary',
    'details',
    'files',
    'evidence',
    'risks',
    'options',
    'findings',
    'verdict',
    'routing',
  ],
};
export function validateHandoff(raw, stage) {
  requireValue(raw && typeof raw === 'object', 'Harness did not return a handoff');
  for (const key of ['summary', 'details']) text(raw[key], key, 100000);
  for (const key of ['files', 'evidence', 'risks'])
    requireValue(
      Array.isArray(raw[key]) && raw[key].every((v) => typeof v === 'string'),
      `Invalid handoff ${key}`,
    );
  requireValue(
    [
      'complete',
      'changes_requested',
      'blocked',
      'repair_requested',
      'verification_requested',
    ].includes(raw.verdict),
    'Invalid handoff verdict',
  );
  requireValue(
    !['repair_requested', 'verification_requested'].includes(raw.verdict) ||
      stage === 'investigate' ||
      (stage === 'implement' && raw.verdict === 'verification_requested'),
    'Only implementation or debugger investigation can request host verification; repair delegation is debugger-only',
  );
  requireValue(
    stage === 'review' || raw.verdict !== 'changes_requested',
    'Only review stages may request changes; other incomplete stages must return blocked',
  );
  requireValue(
    Array.isArray(raw.options) &&
      raw.options.every(
        (o) =>
          o &&
          ['id', 'title', 'description', 'tradeoffs'].every(
            (k) => typeof o[k] === 'string' && o[k].trim(),
          ),
      ),
    'Invalid approach options',
  );
  requireValue(
    new Set(raw.options.map((o) => o.id)).size === raw.options.length,
    'Approach IDs must be unique',
  );
  requireValue(
    Array.isArray(raw.findings) &&
      raw.findings.every(
        (f) =>
          f &&
          ['critical', 'major', 'minor'].includes(f.severity) &&
          typeof f.file === 'string' &&
          typeof f.description === 'string',
      ),
    'Invalid review findings',
  );
  if (stage === 'plan' && raw.verdict === 'complete')
    requireValue(raw.options.length > 0, 'Plan must include at least one approach');
  if (stage === 'triage')
    requireValue(
      raw.routing &&
        ['investigate', 'plan', 'implement', 'review'].every((s) =>
          HARNESSES.includes(raw.routing[s]),
        ),
      'Triage must include valid routing',
    );
  return raw;
}

export function parseHandoff(value) {
  if (typeof value === 'object' && value) return value;
  const trimmed = String(value)
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new InputError(
      'Harness returned an invalid structured handoff. Inspect its transcript, then retry.',
    );
  }
}

export function taskOptions(raw, config) {
  const routing = { ...config.routing, ...(raw.routing ?? {}) };
  requireValue(
    Object.keys(routing).length === Object.keys(config.routing).length &&
      Object.entries(routing).every(
        ([stage, id]) => Object.hasOwn(config.routing, stage) && HARNESSES.includes(id),
      ),
    'Invalid harness routing',
  );
  const models = raw.models ?? {};
  requireValue(
    models &&
      typeof models === 'object' &&
      !Array.isArray(models) &&
      Object.keys(models).every((stage) => Object.hasOwn(config.routing, stage)),
    'Invalid stage models',
  );
  const execution = raw.execution ?? {};
  requireValue(
    execution &&
      typeof execution === 'object' &&
      !Array.isArray(execution) &&
      Object.keys(execution).every((key) =>
        ['timeoutMinutes', 'maxRepairRounds', 'maxRecoveryAttempts'].includes(key),
      ),
    'Invalid execution settings',
  );
  const settings = {};
  for (const [key, min, max] of [
    ['timeoutMinutes', 1, 240],
    ['maxRepairRounds', 1, 10],
    ['maxRecoveryAttempts', 0, 5],
  ]) {
    settings[key] = execution[key] ?? config[key];
    requireValue(
      Number.isInteger(settings[key]) && settings[key] >= min && settings[key] <= max,
      `${key} must be between ${min} and ${max}`,
    );
  }
  requireValue(
    raw.smartRouting === undefined || typeof raw.smartRouting === 'boolean',
    'Smart routing must be a boolean',
  );
  return {
    routing,
    models: Object.fromEntries(
      Object.entries(models).map(([stage, model]) => [stage, text(model, 'Model', 200, true)]),
    ),
    execution: settings,
  };
}
function applyRepositorySettings(repositories, settings = []) {
  requireValue(Array.isArray(settings) && settings.length <= 12, 'Invalid repository settings');
  const seen = new Set();
  for (const setting of settings) {
    requireValue(
      setting &&
        typeof setting === 'object' &&
        !Array.isArray(setting) &&
        Object.keys(setting).every((key) =>
          ['id', 'cwd', 'checks', 'setup', 'instructions'].includes(key),
        ),
      'Invalid task repository settings',
    );
    const entry = repositories.find((entry) => entry.repository.id === setting.id);
    requireValue(
      entry && !seen.has(setting.id),
      'Repository settings must match distinct selected repositories',
    );
    seen.add(setting.id);
    if (setting.cwd !== undefined)
      entry.repository.cwd = text(setting.cwd, 'Working subdirectory', 2000);
    if (setting.instructions !== undefined)
      entry.repository.instructions = text(
        setting.instructions,
        'Repository instructions',
        50000,
        true,
      );
    for (const key of ['checks', 'setup'])
      if (setting[key] !== undefined) {
        requireValue(
          Array.isArray(setting[key]) && setting[key].length <= 30,
          'Too many repository commands',
        );
        entry.repository[key] = setting[key].map(command);
      }
  }
}
export function executionConfig(task, config, stage) {
  const result = { ...structuredClone(config), ...(task.execution ?? {}) };
  const harness = task.routing[stage];
  if (task.models?.[stage] && result.harnesses[harness])
    result.harnesses[harness].model = task.models[stage];
  return result;
}

export function newTask(raw, config) {
  const demo = raw.demo === true;
  const repository = config.repositories.find((r) => r.id === raw.repositoryId);
  requireValue(demo || repository || raw.repositoryIds?.length, 'Select a configured repository');
  const ids = raw.repositoryIds ?? (repository ? [repository.id] : []);
  requireValue(
    Array.isArray(ids) && ids.length <= 12 && ids.every((id) => typeof id === 'string'),
    'Select at most 12 repositories',
  );
  requireValue(demo || ids.length > 0, 'Select a configured repository');
  requireValue(new Set(ids).size === ids.length, 'Duplicate task repositories');
  requireValue(
    !raw.repositoryId || ids.includes(raw.repositoryId),
    'Primary repository must be selected',
  );
  const repositories = ids.map((id) => {
    const profile = config.repositories.find((r) => r.id === id);
    requireValue(profile, 'Unknown task repository');
    return {
      repository: structuredClone(profile),
      workspace: null,
      baseCommit: null,
      branch: null,
    };
  });
  applyRepositorySettings(repositories, raw.repositorySettings);
  const options = taskOptions(raw, config);
  const dependencies = raw.dependencies ?? [];
  requireValue(
    Array.isArray(dependencies) && dependencies.length <= 132,
    'Invalid repository dependencies',
  );
  for (const edge of dependencies)
    requireValue(
      edge &&
        ids.includes(edge.repositoryId) &&
        ids.includes(edge.dependsOn) &&
        edge.repositoryId !== edge.dependsOn,
      'Dependencies must connect distinct selected repositories',
    );
  requireValue(
    new Set(dependencies.map((e) => `${e.repositoryId}:${e.dependsOn}`)).size ===
      dependencies.length,
    'Duplicate dependencies',
  );
  const ordered = [];
  while (ordered.length < repositories.length) {
    const next = repositories.find(
      (r) =>
        !ordered.includes(r) &&
        dependencies
          .filter((e) => e.repositoryId === r.repository.id)
          .every((e) => ordered.some((o) => o.repository.id === e.dependsOn)),
    );
    requireValue(next, 'Repository dependencies contain a cycle');
    ordered.push(next);
  }
  return {
    repositories: demo ? [] : ordered,
    dependencies: structuredClone(dependencies),
    repositoryCursor: 0,
    id: randomUUID(),
    title: text(raw.title, 'Title', 240),
    description: text(raw.description ?? '', 'Description', 50000, true),
    ticket: text(raw.ticket ?? '', 'Ticket', 2000, true),
    demo,
    repository: demo
      ? {
          id: 'demo',
          name: 'Example service',
          path: '',
          cwd: '.',
          strategy: 'worktree',
          checks: [],
          setup: [],
          instructions: '',
        }
      : structuredClone(
          repositories.find((entry) => entry.repository.id === raw.repositoryId)?.repository ??
            repositories[0].repository,
        ),
    ...options,
    configRevision: 0,
    smartRouting: raw.smartRouting === true,
    status: 'draft',
    stage: 'triage',
    round: 0,
    attempts: [],
    approvals: [],
    messages: [],
    workspace: null,
    baseCommit: null,
    branch: null,
    chosenApproach: null,
    reviewedFingerprint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

export function reconfigureTask(task, raw, config) {
  requireValue(
    raw && typeof raw === 'object' && !Array.isArray(raw),
    'Task settings must be an object',
  );
  const allowed = [
    'expectedRevision',
    'title',
    'description',
    'ticket',
    'repositoryId',
    'repositoryIds',
    'dependencies',
    'repositorySettings',
    'routing',
    'models',
    'execution',
    'smartRouting',
  ];
  requireValue(
    Object.keys(raw).every((key) => allowed.includes(key)),
    'Unknown task setting',
  );
  requireValue(
    Number.isInteger(raw.expectedRevision) && raw.expectedRevision === (task.configRevision ?? 0),
    'Task settings changed. Reopen the editor to use the latest settings.',
    409,
  );
  requireValue(
    ['draft', 'paused', 'blocked', 'interrupted', 'awaiting_plan', 'awaiting_final'].includes(
      task.status,
    ),
    'Pause the workflow before editing. Finished tasks can be duplicated.',
    409,
  );
  const current = task.repositories?.length > 1 ? task.repositories : [task];
  const profiles = new Map(config.repositories.map((profile) => [profile.id, profile]));
  for (const entry of current) if (!task.demo) profiles.set(entry.repository.id, entry.repository);
  const candidate = newTask(
    {
      title: task.title,
      description: task.description,
      ticket: task.ticket,
      repositoryId: task.demo ? undefined : task.repository.id,
      repositoryIds: task.demo ? [] : current.map((entry) => entry.repository.id),
      dependencies: task.dependencies ?? [],
      routing: task.routing,
      models: task.models ?? {},
      execution: task.execution ?? {},
      smartRouting: task.smartRouting,
      ...raw,
      demo: task.demo,
    },
    { ...config, repositories: [...profiles.values()] },
  );
  const proposed = candidate.repositories.length ? candidate.repositories : [candidate];
  const started =
    task.status !== 'draft' ||
    task.attempts.length > 0 ||
    current.some((entry) => entry.workspace || entry.baseCommit);
  if (started) {
    const structural = (entries) =>
      entries.map((entry) => ({
        id: entry.repository.id,
        path: entry.repository.path,
        cwd: entry.repository.cwd,
        strategy: entry.repository.strategy,
        setup: entry.repository.setup,
      }));
    requireValue(
      candidate.repository.id === task.repository.id &&
        JSON.stringify(structural(current)) === JSON.stringify(structural(proposed)) &&
        JSON.stringify(candidate.dependencies) === JSON.stringify(task.dependencies ?? []),
      'Repositories, dependencies, setup, and working directories are locked after starting. Duplicate the task to change them.',
      409,
    );
  }
  const scopeChanged =
    task.title !== candidate.title ||
    task.description !== candidate.description ||
    current.some(
      (entry) =>
        entry.repository.instructions !==
        proposed.find((item) => item.repository.id === entry.repository.id)?.repository
          .instructions,
    );
  const checksChanged = current.some(
    (entry) =>
      JSON.stringify(entry.repository.checks) !==
      JSON.stringify(
        proposed.find((item) => item.repository.id === entry.repository.id)?.repository.checks,
      ),
  );
  for (const key of [
    'title',
    'description',
    'ticket',
    'routing',
    'models',
    'execution',
    'smartRouting',
  ])
    task[key] = candidate[key];
  if (!started) {
    task.repository = candidate.repository;
    task.repositories = candidate.repositories;
    task.dependencies = candidate.dependencies;
  } else {
    for (const entry of current)
      entry.repository = structuredClone(
        proposed.find((item) => item.repository.id === entry.repository.id).repository,
      );
    task.repository = structuredClone(
      proposed.find((item) => item.repository.id === task.repository.id).repository,
    );
    if (scopeChanged || checksChanged) {
      task.status = 'paused';
      task.stage = scopeChanged || !task.chosenApproach ? 'investigate' : 'verify';
      task.repositoryCursor = 0;
      if (scopeChanged) task.chosenApproach = null;
      task.reviewedFingerprint = null;
      task.verifiedFingerprint = null;
      task.error = null;
      task.round = 0;
      task.messages.push({
        at: new Date().toISOString(),
        role: 'user',
        text: scopeChanged
          ? 'Task requirements or repository guidance changed. Reinvestigate the current requirements and existing diff, then obtain a new approach approval before implementation.'
          : 'Verification commands changed. Rerun all repository verification and independent review before final acceptance.',
      });
    }
  }
  task.configRevision = (task.configRevision ?? 0) + 1;
  return { task, reset: started && (scopeChanged || checksChanged) };
}
