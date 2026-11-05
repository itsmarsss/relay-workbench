import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { inbox, acknowledge } from '../server/inbox.js';
test('attention receipts persist and new decisions become unread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-inbox-'));
  let store = new Store(dir);
  try {
    const task = { id: 'a', title: 'Review me', status: 'awaiting_plan', attempts: [] };
    store.save(task, { type: 'decision' });
    const first = inbox(store)[0];
    assert.equal(first.seen, false);
    assert.equal(acknowledge(store, first.key), true);
    store.close();
    store = new Store(dir);
    assert.equal(inbox(store)[0].seen, true);
    task.status = 'running';
    store.save(task);
    assert.equal(inbox(store).length, 0);
    task.status = 'awaiting_final';
    store.save(task, { type: 'decision' });
    assert.equal(inbox(store)[0].seen, false);
    assert.equal(acknowledge(store, first.key), false);
    task.status = 'completed';
    store.save(task);
    assert.equal(inbox(store).length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
