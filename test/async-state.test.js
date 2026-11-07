import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshQueue, latestLoader, eventBatch } from '../public/async-state.js';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('continuous refresh events cannot hold the current interaction pending indefinitely', async () => {
  const first = deferred(),
    second = deferred(),
    scheduled = [];
  let calls = 0;
  const refresh = refreshQueue(
    async () => {
      calls++;
      if (calls === 1) await first.promise;
      else if (calls === 2) await second.promise;
    },
    { schedule: (fn) => scheduled.push(fn) },
  );
  const pending = refresh();
  assert.equal(refresh(), pending);
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(refresh(), pending);
  second.resolve();
  await pending;
  assert.equal(calls, 2);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
});

test('a failed refresh releases the queue and a later attempt can succeed', async () => {
  let calls = 0;
  const refresh = refreshQueue(async () => {
    if (++calls === 1) throw Error('Unavailable');
  });
  await assert.rejects(refresh(), /Unavailable/);
  await refresh();
  assert.equal(calls, 2);
});

test('slow results and failures cannot replace a newer diff selection', async () => {
  const requests = new Map(),
    applied = [],
    errors = [];
  let selected = 'a';
  const load = latestLoader(
    (key) => {
      const request = deferred();
      requests.set(key, request);
      return request.promise;
    },
    {
      apply: (value) => applied.push(value),
      fail: (error) => errors.push(error.message),
      isCurrent: (key) => key === selected,
    },
  );
  const old = load('a');
  selected = 'b';
  const current = load('b');
  requests.get('b').resolve('new diff');
  await current;
  requests.get('a').resolve('old diff');
  await old;
  assert.deepEqual(applied, ['new diff']);
  const staleFailure = load('b');
  selected = 'c';
  requests.get('b').reject(Error('old failure'));
  await staleFailure;
  assert.deepEqual(errors, []);
  const failure = load('c');
  requests.get('c').reject(Error('current failure'));
  await failure;
  assert.deepEqual(errors, ['current failure']);
});

test('event paging yields after a bounded batch and continues without repeating rows', async () => {
  const cursors = [];
  const fetchPage = async (after) => {
    cursors.push(after);
    return Array.from({ length: 3 }, (_, i) => ({ seq: after + i + 1 }));
  };
  const one = await eventBatch(fetchPage, 0, { pageSize: 3, maxPages: 2 });
  assert.deepEqual(cursors, [0, 3]);
  assert.equal(one.hasMore, true);
  assert.deepEqual(
    one.events.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6],
  );
  const two = await eventBatch(async (after) => [{ seq: after + 1 }], one.events.at(-1).seq, {
    pageSize: 3,
    maxPages: 2,
  });
  assert.deepEqual(two.events, [{ seq: 7 }]);
  assert.equal(two.hasMore, false);
  await assert.rejects(
    eventBatch(async () => [{ seq: 1 }], 1, { pageSize: 1 }),
    /cursor did not advance/,
  );
});
