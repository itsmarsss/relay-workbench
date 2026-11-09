import { e, badge } from './ui.js';
import { displayStatus } from './task-status.js';
import { runLabel } from './run-label.js';

const storageKey = 'relay-task-deck-v1';
const tabs = ['overview', 'thread', 'terminals', 'diff', 'handoffs', 'transcript'];
const titles = {
  overview: 'Overview',
  thread: 'Activity',
  terminals: 'Terminal',
  diff: 'Changes',
  handoffs: 'Handoffs',
  transcript: 'Logs',
};
const uid = () => crypto.randomUUID();
const leaf = () => ({ id: uid(), taskId: '', view: 'terminals' });
const newTab = (name) => ({ id: uid(), name, root: leaf() });
export const initialDeck = () => ({ tabs: [newTab('Workspace 1')], active: '', focus: '' });
export function findNode(node, id) {
  if (node.id === id) return node;
  return node.kind === 'split' ? findNode(node.first, id) || findNode(node.second, id) : null;
}
export function leaves(node) {
  return node.kind === 'split' ? [...leaves(node.first), ...leaves(node.second)] : [node];
}
function normalizeNode(node, seen, depth = 0) {
  if (
    !node ||
    typeof node !== 'object' ||
    depth > 8 ||
    seen.size >= 15 ||
    typeof node.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(node.id) ||
    seen.has(node.id)
  )
    throw new Error('Invalid layout');
  seen.add(node.id);
  if (node.kind === 'split') {
    const ratio = Number(node.ratio);
    return {
      id: node.id,
      kind: 'split',
      direction: node.direction === 'vertical' ? 'vertical' : 'horizontal',
      ratio: Number.isFinite(ratio) ? Math.min(80, Math.max(20, ratio)) : 50,
      first: normalizeNode(node.first, seen, depth + 1),
      second: normalizeNode(node.second, seen, depth + 1),
    };
  }
  return {
    id: node.id,
    taskId:
      typeof node.taskId === 'string' && /^[a-f0-9-]{36}$/.test(node.taskId) ? node.taskId : '',
    view: tabs.includes(node.view) ? node.view : 'terminals',
  };
}
export function loadDeck(storage) {
  try {
    const data = JSON.parse(storage.getItem(storageKey));
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length || data.tabs.length > 10)
      throw new Error('Invalid tabs');
    const ids = new Set();
    const result = data.tabs.map((tab) => {
      if (!tab || typeof tab.id !== 'string' || !/^[a-f0-9-]{36}$/.test(tab.id) || ids.has(tab.id))
        throw new Error('Invalid tab');
      ids.add(tab.id);
      return {
        id: tab.id,
        name:
          typeof tab.name === 'string' ? tab.name.trim().slice(0, 60) || 'Workspace' : 'Workspace',
        root: normalizeNode(tab.root, new Set()),
      };
    });
    return { tabs: result, active: ids.has(data.active) ? data.active : result[0].id, focus: '' };
  } catch {
    const result = initialDeck();
    result.active = result.tabs[0].id;
    return result;
  }
}
export function saveDeck(storage, deck) {
  try {
    storage.setItem(storageKey, JSON.stringify({ tabs: deck.tabs, active: deck.active }));
  } catch {}
}
export function splitPane(tab, id, direction) {
  if (leaves(tab.root).length >= 8 || !['horizontal', 'vertical'].includes(direction)) return false;
  const pane = findNode(tab.root, id);
  if (!pane || pane.kind === 'split') return false;
  Object.assign(pane, {
    id: uid(),
    kind: 'split',
    direction,
    ratio: 50,
    first: { ...pane },
    second: leaf(),
  });
  return true;
}
export function removePane(tab, id) {
  if (tab.root.id === id) {
    tab.root = leaf();
    return;
  }
  function remove(node) {
    if (node.kind !== 'split') return node;
    if (node.first.id === id) return node.second;
    if (node.second.id === id) return node.first;
    node.first = remove(node.first);
    node.second = remove(node.second);
    return node;
  }
  tab.root = remove(tab.root);
}
export function selectedDeck(deck) {
  return deck.tabs.find((tab) => tab.id === deck.active) ?? deck.tabs[0];
}
export function addDeckTab(deck) {
  if (deck.tabs.length >= 10) return false;
  const tab = newTab(`Workspace ${deck.tabs.length + 1}`);
  deck.tabs.push(tab);
  deck.active = tab.id;
  deck.focus = '';
  return true;
}

function renderPane(node, tasks, focused, count, all) {
  const task = tasks.find((t) => t.id === node.taskId);
  const summary = task?.currentRun
    ? `${task.currentRun.harness || 'Agent'} · ${runLabel(task.currentRun)}`
    : task?.latestSummary || '';
  const options = tasks
    .map(
      (t) =>
        `<option value="${e(t.id)}" ${t.id === node.taskId ? 'selected' : ''}>${e(t.title)}</option>`,
    )
    .join('');
  const sharedManual =
    task?.status === 'manual' &&
    node.view === 'terminals' &&
    all.filter((p) => p.taskId === node.taskId && p.view === 'terminals').length > 1;
  const source = task ? `/?embed=1#task/${encodeURIComponent(task.id)}/${node.view}` : '';
  const hidden = !!all.focus && all.focus !== node.id;
  return `<section class="deck-pane ${focused ? 'deck-focused' : ''}" ${hidden ? 'inert' : ''} id="deck-pane-${e(node.id)}" aria-label="${e(task?.title || 'Empty pane')}"><header class="deck-pane-header"><div class="deck-pane-identity"><label class="sr-only" for="deck-task-${e(node.id)}">Task for pane</label><select id="deck-task-${e(node.id)}" class="input" data-deck-task="${e(node.id)}"><option value="">Choose a task…</option>${node.taskId && !task ? `<option value="${e(node.taskId)}" selected>Task unavailable</option>` : ''}${options}</select>${task ? `<div class="deck-pane-meta">${badge(displayStatus(task))}<span>${e(summary || task.repository?.name || '')}</span></div>` : ''}</div><div class="deck-pane-actions"><button class="btn text small" data-action="deck-focus" data-id="${e(node.id)}" aria-label="${focused ? 'Restore layout' : 'Focus pane'}" title="${focused ? 'Restore layout' : 'Focus pane'}">${focused ? 'Restore' : 'Focus'}</button><button class="btn text small" data-action="deck-split" data-id="${e(node.id)}" data-direction="horizontal" aria-label="Split pane side by side" title="Split side by side" ${count >= 8 ? 'disabled' : ''}>◫</button><button class="btn text small" data-action="deck-split" data-id="${e(node.id)}" data-direction="vertical" aria-label="Split pane top and bottom" title="Split top and bottom" ${count >= 8 ? 'disabled' : ''}>⊟</button><button class="btn text small" data-action="deck-remove-pane" data-id="${e(node.id)}" aria-label="Close pane" title="Close pane">×</button></div></header>${task ? `${sharedManual ? '<p class="deck-shared">Manual terminal panes share input and terminal size.</p>' : ''}<div class="deck-view-bar"><div class="deck-view-tabs" role="group" aria-label="Pane view">${tabs.map((view) => `<button class="deck-view-button ${node.view === view ? 'active' : ''}" data-action="deck-view" data-id="${e(node.id)}" data-view="${view}" aria-pressed="${node.view === view}">${titles[view]}</button>`).join('')}</div><a class="deck-open" href="#task/${e(task.id)}/${e(node.view)}" data-action="deck-open-task" data-id="${e(task.id)}" data-view="${e(node.view)}">Open task ↗</a></div><iframe id="deck-frame-${e(node.id)}" data-deck-frame data-task-id="${e(task.id)}" class="deck-frame" title="${e(task.title)} · ${e(titles[node.view])}" src="${e(source)}"></iframe>` : `<div class="deck-empty"><strong>${node.taskId ? 'Task unavailable' : 'Choose a task'}</strong><p>${node.taskId ? 'This task may have been deleted. Choose another task.' : 'Select a task above to view and manage it here.'}</p></div>`}</section>`;
}
function renderNode(node, tasks, count, all) {
  if (node.kind !== 'split') return renderPane(node, tasks, all.focus === node.id, count, all);
  return `<div class="deck-split ${node.direction}" id="deck-split-${e(node.id)}" data-deck-split="${e(node.id)}"><div class="deck-child">${renderNode(node.first, tasks, count, all)}</div><div class="deck-divider" role="separator" tabindex="0" ${all.focus ? 'inert' : ''} aria-label="Resize panes" aria-orientation="${node.direction === 'horizontal' ? 'vertical' : 'horizontal'}" aria-valuemin="20" aria-valuemax="80" aria-valuenow="${node.ratio}" data-deck-divider="${e(node.id)}"></div><div class="deck-child">${renderNode(node.second, tasks, count, all)}</div></div>`;
}
export function deckView(deck, tasks) {
  const active = selectedDeck(deck),
    all = leaves(active.root),
    count = all.length,
    focused = deck.focus && findNode(active.root, deck.focus);
  const focus = focused && focused.kind !== 'split' ? focused : null;
  all.focus = focus?.id || '';
  return `<section class="deck-page"><header class="deck-heading"><div><h1>Task deck</h1><p>Watch and manage tasks side by side.</p></div><span class="deck-hint">${count}/8 panes · layouts saved in this browser</span></header><nav class="deck-tabs" aria-label="Task deck workspaces">${deck.tabs.map((tab) => `<button class="deck-tab ${tab.id === active.id ? 'active' : ''}" data-action="deck-select-tab" data-id="${e(tab.id)}" aria-current="${tab.id === active.id ? 'page' : 'false'}">${e(tab.name)}</button>`).join('')}<button class="btn text small" data-action="deck-add-tab" ${deck.tabs.length >= 10 ? 'disabled' : ''} aria-label="Add workspace">＋</button><div class="deck-tab-actions"><button class="btn text small" data-action="deck-rename-tab">Rename</button><button class="btn text small" data-action="deck-close-tab" ${deck.tabs.length === 1 ? 'disabled' : ''}>Close tab</button></div></nav><div class="deck-canvas">${renderNode(active.root, tasks, count, all)}</div></section>`;
}
