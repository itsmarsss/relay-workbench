export type ActivityCursor = { seq: number };

// A provider's final message arrives before Relay validates and saves the
// handoff. Keep it visible until the authoritative event is in this window.
export function activityEntries<
  T extends ActivityCursor & {
    type?: unknown;
    kind?: unknown;
    attemptId?: unknown;
    details?: unknown;
  },
>(events: T[]): T[] {
  const handoffs = new Set(
    events
      .filter((row) => row.type === 'handoff' && typeof row.attemptId === 'string' && row.attemptId)
      .map((row) => row.attemptId),
  );
  const results = new Map(
    events
      .filter(
        (row) =>
          row.type === 'activity' &&
          row.kind === 'handoff' &&
          typeof row.attemptId === 'string' &&
          row.attemptId &&
          row.details,
      )
      .map((row) => [row.attemptId, row]),
  );
  return events
    .filter(
      (row) => !(row.type === 'activity' && row.kind === 'handoff' && handoffs.has(row.attemptId)),
    )
    .map((row) => {
      const result = results.get(row.attemptId);
      return row.type === 'handoff' && !row.details && result?.details
        ? { ...row, details: result.details }
        : row;
    });
}

// Keep a bounded window without losing the cursor of rows trimmed from it.
export function activityWindow<T extends ActivityCursor>(
  current: T[],
  incoming: T[],
  direction: 'earlier' | 'later',
  limit = 2000,
) {
  const unique = new Map([...current, ...incoming].map((row) => [row.seq, row]));
  const sorted = [...unique.values()].sort((a, b) => a.seq - b.seq);
  const rows = direction === 'later' ? sorted.slice(-limit) : sorted.slice(0, limit);
  return {
    rows,
    first: rows[0]?.seq || 0,
    last: rows.at(-1)?.seq || 0,
    trimmed: sorted.length > rows.length,
  };
}
