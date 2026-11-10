export type ObjectValue = Record<string, unknown>;
export function asObject(value: unknown): ObjectValue | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}
export function asText(value: unknown, max = 12000): string {
  return typeof value === 'string'
    ? value.slice(0, max) + (value.length > max ? '\n… output truncated' : '')
    : '';
}
export function visibleEvents(
  value: unknown,
  stream: 'activity' | 'logs',
): { title: string; text: string; key: string }[] {
  if (!Array.isArray(value)) throw new Error('Invalid activity response.');
  return value
    .filter((item) => {
      const row = asObject(item);
      return row && (stream === 'logs' ? row.type === 'transcript' : row.type !== 'transcript');
    })
    .slice(-50)
    .map((item, index) => {
      const row = asObject(item)!;
      return {
        key: String(row.seq ?? index),
        title: asText(row.kind || row.type || 'Update', 100),
        text: asText(row.details || row.text || row.message || row.activity || row.summary || ''),
      };
    });
}
export function latestHandoffs(value: unknown): { title: string; text: string; key: string }[] {
  const task = asObject(value);
  if (!task || !Array.isArray(task.attempts)) throw new Error('Invalid task response.');
  return task.attempts
    .filter((item) => asObject(asObject(item)?.handoff) || asObject(item)?.error)
    .slice(-20)
    .reverse()
    .map((item, index) => {
      const run = asObject(item)!,
        handoff = asObject(run.handoff);
      return {
        key: String(run.id ?? index),
        title: asText(run.stage || run.role || 'Run', 100),
        text: asText(handoff?.summary || run.error || 'No summary.'),
      };
    });
}
export type PlanPreview = {
  attemptId: string;
  summary: string;
  details: string;
  recommendedId: string;
  reason: string;
  options: { id: string; title: string; description: string; tradeoffs: string }[];
};
export type BlockerPreview = {
  id: string;
  summary: string;
  explanation: string;
  evidence: string[];
  required: string[];
  options: { id: string; title: string; description: string; tradeoffs: string }[];
};
export function currentBlocker(value: unknown): BlockerPreview | null {
  const task = asObject(value),
    blocker = asObject(task?.blockerDecision);
  if (
    task?.status !== 'blocked' ||
    !blocker ||
    blocker.resolved === true ||
    typeof blocker.id !== 'string' ||
    !blocker.id
  )
    return null;
  const strings = (items: unknown) =>
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string').slice(0, 100)
      : [];
  const options = Array.isArray(blocker.options)
    ? blocker.options.flatMap((item) => {
        const option = asObject(item);
        if (
          !option ||
          typeof option.id !== 'string' ||
          !option.id ||
          typeof option.title !== 'string' ||
          typeof option.description !== 'string' ||
          typeof option.tradeoffs !== 'string'
        )
          return [];
        return [
          {
            id: option.id,
            title: asText(option.title, 1000),
            description: asText(option.description, 20000),
            tradeoffs: asText(option.tradeoffs, 20000),
          },
        ];
      })
    : [];
  return {
    id: blocker.id,
    summary: asText(blocker.summary, 20000),
    explanation: asText(blocker.explanation, 50000),
    evidence: strings(blocker.evidence),
    required: strings(blocker.required),
    options,
  };
}
export function latestPlan(value: unknown): PlanPreview | null {
  const task = asObject(value);
  if (!task || !Array.isArray(task.attempts)) return null;
  const followUp = asObject(task.followUpContext);
  const attempt = task.attempts.findLast((item) => {
    const run = asObject(item),
      handoff = asObject(run?.handoff);
    if (
      run?.stage !== 'plan' ||
      run.status !== 'complete' ||
      run.role === 'debug' ||
      handoff?.verdict !== 'complete'
    )
      return false;
    if (typeof followUp?.id === 'string' && followUp.id) {
      if (typeof run.followUpId === 'string' && run.followUpId)
        return run.followUpId === followUp.id;
      if (typeof run.startedAt !== 'string' || typeof followUp.startedAt !== 'string') return false;
      const started = Date.parse(run.startedAt),
        after = Date.parse(followUp.startedAt);
      return Number.isFinite(started) && Number.isFinite(after) && started >= after;
    }
    return true;
  });
  const run = asObject(attempt),
    handoff = asObject(run?.handoff);
  if (!run || typeof run.id !== 'string' || !run.id || !handoff || !Array.isArray(handoff.options))
    return null;
  const options = handoff.options.map((item) => {
    const option = asObject(item);
    return {
      id: typeof option?.id === 'string' ? option.id : '',
      title: asText(option?.title, 1000),
      description: asText(option?.description, 20000),
      tradeoffs: asText(option?.tradeoffs, 20000),
    };
  });
  if (
    !options.length ||
    options.some(
      (option) => !option.id || !option.title || !option.description || !option.tradeoffs,
    )
  )
    return null;
  const recommendedId =
    typeof handoff.recommendedOptionId === 'string' ? handoff.recommendedOptionId : '';
  return {
    attemptId: run.id,
    summary: asText(handoff.summary, 20000),
    details: asText(handoff.details, 50000),
    recommendedId: options.some((option) => option.id === recommendedId) ? recommendedId : '',
    reason: asText(handoff.recommendationReason, 20000),
    options,
  };
}
export type DiffRepository = {
  id: string;
  name: string;
  text: string;
  stat: string;
  untracked: { name: string; content: string }[];
  message: string;
  omitted: boolean;
  omittedCount: number;
};
export function parseDiff(value: unknown): DiffRepository[] {
  const data = asObject(value);
  if (!data || !Array.isArray(data.repositories) || data.repositories.length > 12)
    throw new Error('Invalid changes response.');
  return data.repositories.map((item) => {
    const row = asObject(item),
      diff = asObject(row?.diff);
    if (!row || typeof row.repositoryId !== 'string' || typeof row.name !== 'string')
      throw new Error('Invalid changes response.');
    if (!diff)
      return {
        id: row.repositoryId,
        name: row.name,
        text: '',
        stat: '',
        untracked: [],
        message: asText(row.reason || row.message, 2000),
        omitted: row.omitted === true,
        omittedCount: 0,
      };
    if (
      typeof diff.text !== 'string' ||
      typeof diff.stat !== 'string' ||
      !Array.isArray(diff.untracked)
    )
      throw new Error('Invalid changes response.');
    const untracked = diff.untracked.map((entry) => {
      const file = asObject(entry);
      if (!file || typeof file.name !== 'string' || typeof file.content !== 'string')
        throw new Error('Invalid changes response.');
      return { name: file.name, content: file.content };
    });
    return {
      id: row.repositoryId,
      name: row.name,
      text: diff.text,
      stat: diff.stat,
      untracked,
      message: asText(diff.reason, 2000),
      omitted: diff.omitted === true,
      omittedCount:
        typeof diff.untrackedOmitted === 'number' &&
        Number.isSafeInteger(diff.untrackedOmitted) &&
        diff.untrackedOmitted > 0
          ? diff.untrackedOmitted
          : 0,
    };
  });
}
export function diffPreviewLines(
  text: string,
  limit = 4000,
): { lines: { text: string; kind: string }[]; truncated: boolean } {
  const lines: { text: string; kind: string }[] = [];
  let cursor = 0;
  while (cursor < text.length && lines.length < limit) {
    const next = text.indexOf('\n', cursor),
      end = next < 0 ? text.length : next;
    const line = text.slice(cursor, end);
    const kind =
      line.startsWith('+') && !line.startsWith('+++')
        ? 'addition'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'deletion'
          : line.startsWith('@@')
            ? 'hunk'
            : '';
    lines.push({ text: line, kind });
    cursor = next < 0 ? text.length : next + 1;
  }
  return { lines, truncated: cursor < text.length };
}
export function liveTerminal(value: unknown): { id: string; label: string } | null {
  const task = asObject(value);
  if (!task) throw new Error('Invalid task response.');
  const manual = asObject(task.manual);
  if (task.status === 'manual' && manual?.active === true && typeof manual.session === 'string')
    return { id: 'manual', label: 'Your shell' };
  if (task.status === 'running' && Array.isArray(task.attempts)) {
    const attempt = task.attempts.findLast((item) => {
      const run = asObject(item);
      return run?.status === 'running' && !!run.terminal && typeof run.id === 'string';
    });
    const run = asObject(attempt);
    if (run && typeof run.id === 'string')
      return {
        id: run.id,
        label: `${asText(run.harness || 'Agent', 100)} · ${asText(run.stage || 'Run', 100)}`,
      };
  }
  const entries =
    Array.isArray(task.repositories) && task.repositories.length ? task.repositories : [task];
  for (const entry of entries) {
    const workspace = asObject(entry);
    for (const key of ['delivery', 'publicationMonitor']) {
      const run = asObject(workspace?.[key]);
      if (run?.status === 'running' && run.terminal) {
        const id = run.id ?? run.attemptId;
        if (typeof id === 'string')
          return { id, label: key === 'delivery' ? 'Publication' : 'PR monitoring' };
      }
    }
  }
  return null;
}

export function eventPage(value: unknown, after: number, stream: 'activity' | 'logs') {
  if (!Array.isArray(value)) throw new Error('Invalid activity response.');
  let cursor = after;
  for (const item of value) {
    const seq = asObject(item)?.seq;
    if (!Number.isSafeInteger(seq) || (seq as number) <= cursor)
      throw new Error('Invalid activity cursor.');
    cursor = seq as number;
  }
  return { cursor, more: value.length >= 1000, entries: visibleEvents(value, stream) };
}

export function externalURL(value: unknown): string | null {
  try {
    const url = new URL(asText(value));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
