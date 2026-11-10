import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeck, panes, parseDeck, removeNode, splitNode, updateNode } from './deck.ts';

test('layouts retain existing panes across nested splits, updates, and close', () => {
  const deck = newDeck(),
    root = deck.tabs[0]!.root,
    first = root.id;
  const split = splitNode(root, first, 'horizontal');
  assert.equal(panes(split).length, 2);
  const second = panes(split)[1]!;
  const nested = splitNode(split, second.id, 'vertical');
  const third = panes(nested)[2]!;
  const edited = updateNode(nested, first, (pane) =>
    pane.type === 'pane' ? { ...pane, taskId: 'a5f083b8-b291-4eb4-b5b1-16679076c777' } : pane,
  );
  const reduced = removeNode(edited, second.id);
  assert.deepEqual(
    panes(reduced).map((pane) => pane.id),
    [first, third.id],
  );
  assert.equal(panes(reduced)[0]!.taskId, 'a5f083b8-b291-4eb4-b5b1-16679076c777');
});
test('saved layouts validate shape, clamp dimensions, and reject hostile data', () => {
  const deck = newDeck();
  deck.tabs[0]!.root = splitNode(deck.tabs[0]!.root, deck.tabs[0]!.root.id, 'vertical');
  if (deck.tabs[0]!.root.type === 'split') deck.tabs[0]!.root.ratio = 10000;
  const result = parseDeck(JSON.stringify(deck));
  assert.equal(result.tabs[0]!.root.type === 'split' && result.tabs[0]!.root.ratio, 80);
  assert.notEqual(parseDeck('{bad').active, '');
  assert.equal(parseDeck(JSON.stringify({ tabs: Array(11).fill({}) })).tabs.length, 1);
});
test('splitting stops at eight panes', () => {
  let root = newDeck().tabs[0]!.root;
  while (panes(root).length < 8) root = splitNode(root, panes(root).at(-1)!.id, 'horizontal');
  assert.equal(splitNode(root, panes(root)[0]!.id, 'vertical'), root);
});

test('grid migration preserves pane identities, views and freeform geometry', () => {
  const saved = newDeck();
  const root = splitNode(saved.tabs[0]!.root, saved.tabs[0]!.root.id, 'vertical');
  saved.tabs[0] = { id: saved.tabs[0]!.id, name: 'Existing layout', root };
  const migrated = parseDeck(JSON.stringify(saved));
  assert.equal(migrated.tabs[0]!.layout, 'grid');
  assert.equal(migrated.tabs[0]!.columns, 2);
  assert.equal(migrated.tabs[0]!.density, 'auto');
  const manual = parseDeck(
    JSON.stringify({ ...saved, tabs: [{ ...saved.tabs[0], density: 'fixed', columns: 4 }] }),
  );
  assert.equal(manual.tabs[0]!.columns, 4);
  assert.equal(manual.tabs[0]!.density, 'fixed');
  assert.deepEqual(migrated.tabs[0]!.root, root);
  assert.equal(
    parseDeck(
      JSON.stringify({ ...saved, tabs: [{ ...saved.tabs[0], layout: 'split', columns: 3 }] }),
    ).tabs[0]!.layout,
    'split',
  );
});

test('grid additions and reordering preserve every task and layout node', async () => {
  const { addPane, movePane } = await import('./deck.ts');
  const first = addPane(newDeck().tabs[0]!.root, 'first');
  const second = addPane(first, 'second');
  const third = addPane(second, 'third');
  const before = panes(third);
  assert.equal(before.length, 3);
  const moved = movePane(third, before[2]!.id, before[0]!.id);
  assert.deepEqual(
    panes(moved).map((pane) => pane.taskId),
    ['third', 'first', 'second'],
  );
  assert.deepEqual(
    new Set(panes(moved).map((pane) => pane.id)),
    new Set(before.map((pane) => pane.id)),
  );
  assert.equal(movePane(third, 'missing', before[0]!.id), third);
  let bounded = moved;
  while (panes(bounded).length < 8) bounded = addPane(bounded, 'extra');
  assert.equal(addPane(bounded, 'overflow'), bounded);
});
