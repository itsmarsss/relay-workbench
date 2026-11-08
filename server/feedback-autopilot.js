import { createHash } from 'node:crypto';
import { requireValue } from './domain.js';
import { workspaces } from './task-repositories.js';
export function feedbackItems(raw = []) {
  requireValue(Array.isArray(raw) && raw.length <= 30, 'Invalid PR feedback list');
  return raw.map((item) => {
    requireValue(
      item && ['repair', 'decision', 'question'].includes(item.kind),
      'Invalid PR feedback classification',
    );
    for (const key of ['id', 'summary', 'details', 'url'])
      requireValue(
        typeof item[key] === 'string' && item[key].length <= (key === 'details' ? 12000 : 2000),
        `Invalid feedback ${key}`,
      );
    requireValue(
      item.id.trim() && item.summary.trim(),
      'Feedback needs a stable source identity and summary',
    );
    if (item.url) {
      let url;
      try {
        url = new URL(item.url);
      } catch {
        requireValue(false, 'Invalid feedback URL');
      }
      requireValue(
        ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password,
        'Invalid feedback URL',
      );
    }
    const value = Object.fromEntries(
      ['id', 'kind', 'summary', 'details', 'url'].map((key) => [key, item[key]]),
    );
    return {
      ...value,
      signature: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    };
  });
}
export class FeedbackAutopilot {
  constructor(store, engine, publisher) {
    this.store = store;
    this.engine = engine;
    this.publisher = publisher;
  }
  configure(id, repositoryId, enabled) {
    const task = this.store.get(id),
      entry = workspaces(task).find((e) => e.repository.id === repositoryId);
    requireValue(
      entry &&
        (!enabled ||
          (task.status === 'completed' &&
            !task.demo &&
            task.preset !== 'investigate' &&
            entry.publication?.state === 'open')),
      'Enable feedback on an accepted task with an open PR',
      409,
    );
    requireValue(typeof enabled === 'boolean', 'Choose whether feedback automation is enabled');
    entry.feedbackAutopilot = { ...entry.feedbackAutopilot, enabled };
    this.store.save(task, {
      type: 'publication',
      summary: `PR feedback automation ${enabled ? 'enabled' : 'paused'} for ${entry.repository.name}.`,
    });
    return task;
  }
  async observe(id, repositoryId, raw) {
    const items = feedbackItems(raw);
    const task = this.store.get(id),
      entry = workspaces(task).find((e) => e.repository.id === repositoryId);
    if (
      !entry?.feedbackAutopilot?.enabled ||
      task.status !== 'completed' ||
      entry.publication?.state !== 'open'
    )
      return;
    const policy = entry.feedbackAutopilot;
    const seen = new Set((policy.history ?? []).flatMap((record) => record.signatures));
    const fresh = items.filter((item) => !seen.has(item.signature));
    if (
      !fresh.length ||
      ['proposed', 'needs_decision', 'publishing'].includes(policy.current?.state)
    )
      return;
    const history = (policy.history ??= []);
    const record = {
      id: createHash('sha256')
        .update(fresh.map((i) => i.signature).join(':'))
        .digest('hex'),
      signatures: fresh.map((i) => i.signature),
      items: fresh,
      at: new Date().toISOString(),
      state: 'needs_decision',
    };
    const rounds = history.filter((r) => r.state !== 'dismissed').length;
    policy.current = record;
    history.push(record);
    if (rounds >= 3)
      record.reason =
        'Three feedback repair cycles have already run. Review the remaining feedback before starting another.';
    else if (fresh.some((item) => item.kind !== 'repair'))
      record.reason =
        'Feedback includes a question or design decision. Supply your direction before implementation.';
    else {
      record.state = 'proposed';
      record.reason =
        'Preparing a repair proposal. You approve implementation and accept the final result before Relay updates the PR.';
    }
    this.store.save(task, {
      type: 'publication',
      observationChange: true,
      summary: record.reason,
      details: fresh.map((i) => i.summary).join('\n'),
    });
    if (record.state !== 'proposed') return;
    try {
      await this.engine.action(id, 'follow-up', {
        message:
          'Address the following observed PR feedback within the existing approved goal. Read the linked source feedback, distinguish routine repairs from product decisions, reuse passing evidence, and propose a focused repair. Do not publish or send comments.\n' +
          fresh
            .map(
              (i) =>
                `${i.kind}: ${i.summary.slice(0, 300)}\n${i.details.slice(0, 600)}\nSource: ${i.url}`,
            )
            .join('\n\n')
            .slice(0, 18000),
      });
    } catch (error) {
      const latest = this.store.get(id),
        current = workspaces(latest).find(
          (e) => e.repository.id === repositoryId,
        ).feedbackAutopilot;
      current.current.state = 'needs_decision';
      current.current.reason = error.message;
      current.history.find((r) => r.id === record.id).state = 'needs_decision';
      this.store.save(latest, {
        type: 'publication',
        observationChange: true,
        summary: 'Feedback proposal could not start.',
        details: error.message,
      });
    }
  }
  dismiss(id, repositoryId, recordId) {
    const task = this.store.get(id),
      entry = workspaces(task).find((e) => e.repository.id === repositoryId),
      policy = entry?.feedbackAutopilot;
    requireValue(
      policy?.current?.id === recordId && policy.current.state === 'needs_decision',
      'Feedback changed; refresh before resolving',
      409,
    );
    policy.current.state = 'dismissed';
    policy.history.find((r) => r.id === recordId).state = 'dismissed';
    this.store.save(task, {
      type: 'decision',
      summary: 'PR feedback marked reviewed. No external reply was posted.',
    });
    return task;
  }
  async afterAccept(id) {
    const task = this.store.get(id);
    if (task.status !== 'completed') return;
    const entry = workspaces(task).find(
      (e) => e.feedbackAutopilot?.enabled && e.feedbackAutopilot.current?.state === 'proposed',
    );
    if (!entry) return;
    const policy = entry.feedbackAutopilot,
      recordId = policy.current.id;
    policy.current.state = 'publishing';
    policy.history.find((r) => r.id === recordId).state = 'publishing';
    this.store.save(task);
    try {
      await this.publisher.start(id, entry.repository.id);
    } catch (error) {
      const latest = this.store.get(id),
        current = workspaces(latest).find(
          (e) => e.repository.id === entry.repository.id,
        ).feedbackAutopilot;
      current.current.state = 'needs_decision';
      current.current.reason = error.message;
      current.history.find((r) => r.id === recordId).state = 'needs_decision';
      this.store.save(latest);
    }
  }
}
