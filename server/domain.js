import { randomUUID } from 'node:crypto';

export const STAGES = ['triage', 'investigate', 'plan', 'implement', 'verify', 'review'];
export const HARNESSES = ['codex', 'claude', 'pi'];
export const DEFAULT_CONFIG = {
  concurrency: 2,
  maxRepairRounds: 3,
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
    requireValue(['worktree', 'attach'].includes(strategy), 'Unknown workspace strategy');
    const checks = (r.checks ?? []).map(command);
    const setup = (r.setup ?? []).map(command);
    requireValue(checks.length <= 30 && setup.length <= 30, 'Too many commands');
    return {
      id: r.id ? text(r.id, 'Repository ID', 100) : randomUUID(),
      name: text(r.name, 'Repository name', 100),
      path: text(r.path, 'Repository path', 2000),
      cwd: text(r.cwd ?? '.', 'Working subdirectory', 2000),
      strategy,
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
    verdict: { type: 'string', enum: ['complete', 'changes_requested', 'blocked'] },
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
    ['complete', 'changes_requested', 'blocked'].includes(raw.verdict),
    'Invalid handoff verdict',
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

export function newTask(raw, config) {
  const demo = raw.demo === true;
  const repository = config.repositories.find((r) => r.id === raw.repositoryId);
  requireValue(demo || repository, 'Select a configured repository');
  return {
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
      : structuredClone(repository),
    routing: { ...config.routing, ...(raw.routing ?? {}) },
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
