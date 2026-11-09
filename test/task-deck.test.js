import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialDeck,
  loadDeck,
  saveDeck,
  selectedDeck,
  addDeckTab,
  splitPane,
  removePane,
  findNode,
  leaves,
  deckView,
} from '../public/task-deck.js';
const store = () => {
  let value;
  return {
    getItem: () => value,
    setItem: (_, next) => {
      value = next;
    },
  };
};
test('deck layouts split, resize, close and persist without losing other panes', () => {
  const deck = initialDeck();
  deck.active = deck.tabs[0].id;
  const tab = selectedDeck(deck),
    first = tab.root.id;
  assert.equal(splitPane(tab, first, 'horizontal'), true);
  const second = leaves(tab.root)[1].id;
  assert.equal(splitPane(tab, second, 'vertical'), true);
  const third = leaves(tab.root)[2].id;
  assert.ok(findNode(tab.root, first));
  assert.equal(leaves(tab.root).length, 3);
  tab.root.ratio = 64;
  const storage = store();
  saveDeck(storage, deck);
  const restored = loadDeck(storage);
  assert.equal(selectedDeck(restored).root.ratio, 64);
  removePane(selectedDeck(restored), second);
  assert.deepEqual(
    leaves(selectedDeck(restored).root).map((p) => p.id),
    [first, third],
  );
  assert.equal(addDeckTab(restored), true);
  assert.equal(restored.tabs.length, 2);
});
test('invalid stored layouts recover safely and limits prevent unbounded panes', () => {
  const storage = { getItem: () => '{"tabs":[{"root":{"kind":"split"}}]}' };
  assert.equal(loadDeck(storage).tabs.length, 1);
  const deck = initialDeck(),
    tab = deck.tabs[0];
  while (leaves(tab.root).length < 8)
    assert.equal(splitPane(tab, leaves(tab.root).at(-1).id, 'horizontal'), true);
  assert.equal(splitPane(tab, leaves(tab.root)[0].id, 'vertical'), false);
  assert.equal(leaves(tab.root).length, 8);
});
test('deck escapes task labels and unavailable task panes remain recoverable', () => {
  const deck = initialDeck();
  deck.active = deck.tabs[0].id;
  const pane = deck.tabs[0].root;
  pane.taskId = 'c0b3c4b6-8f1d-4805-8aa2-77e6d8f148ee';
  const html = deckView(deck, [
    { id: pane.taskId, title: '<img onerror=bad>', status: 'draft', repository: { name: 'A' } },
  ]);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.match(deckView(deck, []), /Task unavailable/);
});

test('focusing preserves every mounted task frame and warns about shared manual terminals', () => {
  const deck = initialDeck();
  deck.active = deck.tabs[0].id;
  const tab = selectedDeck(deck),
    first = tab.root.id;
  splitPane(tab, first, 'horizontal');
  const panes = leaves(tab.root),
    taskId = 'c0b3c4b6-8f1d-4805-8aa2-77e6d8f148ee';
  panes.forEach((pane) => {
    pane.taskId = taskId;
  });
  deck.focus = panes[0].id;
  const html = deckView(deck, [
    { id: taskId, title: 'Task', status: 'manual', repository: { name: 'A' } },
  ]);
  assert.equal((html.match(/<iframe/g) || []).length, 2);
  assert.equal((html.match(/share input and terminal size/g) || []).length, 2);
  assert.match(html, /deck-focused/);
  assert.match(html, /inert/);
});
