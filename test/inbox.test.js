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

test('notifications require opt-in, deduplicate decisions and skip seen items', async () => {
  const { notifyInbox } = await import('../public/inbox.js');
  const original = {
    window: globalThis.window,
    Notification: globalThis.Notification,
    localStorage: globalThis.localStorage,
  };
  const values = new Map(),
    sent = [];
  class Notification {
    static permission = 'granted';
    constructor(title, options) {
      sent.push({ title, options });
    }
  }
  globalThis.window = { Notification };
  globalThis.Notification = Notification;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const item = { key: 'one', title: 'Review work', action: 'Choose an approach', seen: false };
    notifyInbox([item]);
    assert.equal(sent.length, 0);
    values.set('relay-notifications', 'enabled');
    notifyInbox([item]);
    notifyInbox([item]);
    assert.equal(sent.length, 1);
    notifyInbox([{ ...item, key: 'seen', seen: true }]);
    assert.equal(sent.length, 1);
    Notification.permission = 'denied';
    notifyInbox([{ ...item, key: 'denied' }]);
    assert.equal(sent.length, 1);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('publishing blockers appear in the inbox without reopening accepted implementation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-inbox-publishing-'));
  const store = new Store(directory);
  try {
    const task = {
      id: 'published',
      title: 'Accepted task',
      status: 'completed',
      attempts: [],
      repository: { id: 'repo' },
      delivery: {
        id: 'first',
        status: 'blocked',
        summary: 'Remote unavailable',
        nextAction: 'Restore access',
      },
    };
    store.save(task);
    const first = inbox(store)[0];
    assert.equal(first.status, 'blocked');
    assert.equal(first.action, 'Resolve publishing blocker');
    assert.equal(first.summary, 'Restore access');
    acknowledge(store, first.key);
    assert.equal(inbox(store)[0].seen, true);
    task.delivery = { id: 'second', status: 'interrupted', summary: 'Paused' };
    store.save(task);
    assert.equal(inbox(store)[0].seen, false);
    task.delivery.status = 'running';
    store.save(task);
    assert.equal(inbox(store).length, 0);
    assert.equal(store.get(task.id).status, 'completed');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
