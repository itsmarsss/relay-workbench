// Coalesce bursts without keeping an interaction pending for a busy event stream.
export function refreshQueue(
  snapshot,
  { schedule = (run) => setTimeout(run, 0), onError = () => {} } = {},
) {
  let inFlight = null,
    again = false;
  const refresh = () => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      again = false;
      await snapshot();
      if (again) {
        again = false;
        await snapshot();
      }
    })().finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        schedule(() => refresh().catch(onError));
      }
    });
    return inFlight;
  };
  return refresh;
}

// A slow response or error from a previous selection cannot replace the current view.
export function latestLoader(load, { apply, fail, isCurrent = () => true }) {
  let generation = 0;
  return async (key) => {
    const request = ++generation;
    try {
      const value = await load(key);
      if (request === generation && isCurrent(key)) apply(value);
    } catch (error) {
      if (request === generation && isCurrent(key)) fail(error);
    }
  };
}

// Bound each snapshot even if a noisy process continuously fills event pages.
export async function eventBatch(fetchPage, after = 0, { pageSize = 1000, maxPages = 5 } = {}) {
  const events = [];
  let hasMore = false;
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(after);
    events.push(...rows);
    hasMore = rows.length === pageSize;
    if (!hasMore) break;
    const next = rows.at(-1)?.seq;
    if (!(next > after))
      throw Error(
        'Activity cursor did not advance; refresh paused to avoid repeating the same page',
      );
    after = next;
  }
  return { events, hasMore };
}
