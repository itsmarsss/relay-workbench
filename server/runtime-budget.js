export class RuntimeBudgetError extends Error {
  constructor(message, budget) {
    super(message);
    this.code = 'RUNTIME_BUDGET_EXHAUSTED';
    this.budget = budget;
  }
}
// Progress extends a soft deadline, never the absolute cap. Polling alone is not progress.
export class RuntimeBudget {
  constructor({
    timeout,
    startedAt = Date.now(),
    maxTimeout = timeout * 2,
    progressWindow = Math.min(timeout / 2, 10 * 60000),
  }) {
    this.startedAt = startedAt;
    this.timeout = timeout;
    this.softDeadline = startedAt + timeout;
    this.hardDeadline = startedAt + Math.max(timeout, maxTimeout);
    this.progressWindow = progressWindow;
    this.extensions = 0;
  }
  evaluate(now, lastProgressAt) {
    if (now < this.softDeadline) return 'wait';
    if (
      now < this.hardDeadline &&
      Number.isFinite(lastProgressAt) &&
      lastProgressAt > this.startedAt &&
      now - lastProgressAt <= this.progressWindow
    ) {
      this.softDeadline = Math.min(
        this.hardDeadline,
        now + Math.max(50, Math.min(this.timeout / 4, 15 * 60000)),
      );
      this.extensions++;
      return 'extend';
    }
    return 'stop';
  }
  snapshot(lastProgressAt) {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      softDeadlineAt: new Date(this.softDeadline).toISOString(),
      hardDeadlineAt: new Date(this.hardDeadline).toISOString(),
      extensions: this.extensions,
      lastProgressAt: lastProgressAt ? new Date(lastProgressAt).toISOString() : null,
    };
  }
}
