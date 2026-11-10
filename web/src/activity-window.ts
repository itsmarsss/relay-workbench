export type ActivityCursor = { seq: number };

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
