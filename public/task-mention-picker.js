import { mentionPresent, withoutMention } from './task-mentions.js';
import { escapeHTML as e } from './escape.js';
import { animateSurface } from './motion-preferences.js';
const key = 'relay-workspace-mentions';
let draftCache = [];
export function composerMentions(input) {
  try {
    const values = JSON.parse(
      input.id === 'workspace-request'
        ? localStorage.getItem(key) || JSON.stringify(draftCache)
        : input.dataset.taskMentions || '[]',
    );
    return Array.isArray(values)
      ? values.filter((m) => m && typeof m.id === 'string' && typeof m.label === 'string')
      : [];
  } catch {
    return input.id === 'workspace-request' ? draftCache : [];
  }
}
function save(input, values) {
  if (input.id === 'workspace-request') {
    draftCache = values;
    try {
      localStorage.setItem(key, JSON.stringify(values));
    } catch {}
  } else input.dataset.taskMentions = JSON.stringify(values);
}
export function clearComposerMentions(input) {
  save(input, []);
}
export function submittedMentions(input) {
  return composerMentions(input)
    .filter((m) => m.attached || mentionPresent(input.value, m.label))
    .map(({ id, label }) => ({ id, label }));
}
export function composedQuestion(input) {
  const extra = submittedMentions(input).filter((m) => !mentionPresent(input.value, m.label));
  return [input.value.trim(), extra.map((m) => '@' + m.label).join(' ')]
    .filter(Boolean)
    .join('\n\n');
}
const hydrated = new WeakSet();
export function syncTaskComposer(input) {
  if (!input) return;
  if (!hydrated.has(input)) {
    hydrated.add(input);
    const mentions = composerMentions(input).filter(
      (m) => m.attached || mentionPresent(input.value, m.label),
    );
    let migrated = false;
    for (const m of mentions) {
      if (!m.attached) {
        migrated = true;
        input.value = withoutMention(input.value, m.label);
      }
      m.attached = true;
    }
    save(input, mentions);
    if (migrated) input.value = input.value.trim();
    if (input.id === 'workspace-request')
      input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const mentions = composerMentions(input).filter((m) => m.attached);
  let row = input.parentElement.querySelector(':scope > .composer-task-chips');
  if (!row) {
    row = document.createElement('div');
    row.className = 'composer-task-chips';
    row.setAttribute('aria-label', 'Referenced tasks');
    input.before(row);
  }
  const markup = mentions
    .map(
      (m) =>
        `<span class="composer-task-chip" title="${e(m.label)}"><span aria-hidden="true">@</span><span>${e(m.label)}</span><button type="button" data-remove-mention="${e(m.id)}" aria-label="Remove task ${e(m.label)}">×</button></span>`,
    )
    .join('');
  const signature = JSON.stringify(mentions);
  if (row.dataset.mentions !== signature) {
    row.dataset.mentions = signature;
    row.innerHTML = markup;
  }
  row.hidden = !mentions.length;
  input.required = !mentions.length;
  if (input.id === 'workspace-request') {
    input.style.height = '0px';
    const height = Math.max(30, Math.min(180, input.scrollHeight));
    input.style.height = height + 'px';
    input.style.overflowY = input.scrollHeight > 180 ? 'auto' : 'hidden';
  }
}
export function installTaskMentions(getTasks) {
  let panel,
    input,
    trigger,
    options = [],
    selected = 0,
    suppress = false;
  const accepts = (el) =>
    el?.matches?.('#workspace-request,#chat-edit-question[data-task-mentions]');
  function close() {
    if (panel) {
      panel.remove();
      panel = null;
    }
    if (input) {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      input.removeAttribute('aria-controls');
    }
    options = [];
  }
  function position() {
    if (!panel || !input?.isConnected) return close();
    const r = input.getBoundingClientRect(),
      width = Math.min(440, innerWidth - 24, r.width),
      above = r.top > innerHeight - r.bottom;
    const space = above ? r.top - 16 : innerHeight - r.bottom - 16;
    panel.style.width = width + 'px';
    panel.style.maxHeight = Math.max(80, Math.min(300, space)) + 'px';
    panel.style.left = Math.max(12, Math.min(r.left, innerWidth - width - 12)) + 'px';
    panel.style.top = above ? 'auto' : r.bottom + 6 + 'px';
    panel.style.bottom = above ? innerHeight - r.top + 6 + 'px' : 'auto';
  }
  function paint() {
    panel.innerHTML = `<div class="mention-picker-heading">Mention a task <small>↑ ↓ to choose · Enter to insert</small></div><div role="listbox" id="task-mention-options" aria-label="Tasks">${options.map((t, i) => `<button type="button" role="option" id="task-mention-option-${i}" aria-selected="${i === selected}" data-mention-index="${i}"><strong>${e(t.title)}</strong><small>${e(t.repository?.name || t.repositories?.map((r) => r.repository.name).join(' + ') || '')} · ${e(t.status.replaceAll('_', ' '))} · ${e(t.id.slice(0, 8))}</small></button>`).join('') || '<p class="mention-empty" role="status">No matching tasks</p>'}</div>`;
    input.setAttribute(
      'aria-activedescendant',
      options.length ? 'task-mention-option-' + selected : '',
    );
    position();
    const chosen = panel.querySelector('[aria-selected="true"]');
    if (chosen) {
      const item = chosen.getBoundingClientRect(),
        bounds = panel.getBoundingClientRect();
      if (item.bottom > bounds.bottom) panel.scrollTop += item.bottom - bounds.bottom;
      else if (item.top < bounds.top) panel.scrollTop -= bounds.top - item.top;
    }
  }
  function choose(index) {
    const task = options[index];
    if (!task) return;
    const existing = getTasks().filter((t) => t.title === task.title);
    const label = task.title + (existing.length > 1 ? ' · ' + task.id.slice(0, 8) : '');
    const values = composerMentions(input).filter((m) => m.id !== task.id);
    values.push({ id: task.id, label, attached: true });
    save(input, values);
    const target = input;
    target.setRangeText('', trigger.start, target.selectionStart, 'end');
    syncTaskComposer(target);
    close();
    target.focus({ preventScroll: true });
    suppress = true;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    suppress = false;
  }
  function update(target) {
    if (suppress) return;
    if (!accepts(target)) return close();
    if (panel && input !== target) close();
    const prefix = target.value.slice(0, target.selectionStart);
    const match = prefix.match(/(?:^|[\s(])@([^@\n]{0,100})$/);
    if (!match) return close();
    const start = prefix.lastIndexOf('@');
    if (composerMentions(target).some((m) => prefix.slice(start).startsWith('@' + m.label + ' ')))
      return close();
    const query = match[1].trim().toLowerCase();
    const next = getTasks()
      .filter((t) =>
        query
          .split(/\s+/)
          .every((word) =>
            [
              t.title,
              t.id,
              t.ticket,
              t.repository?.name,
              ...(t.repositories ?? []).map((r) => r.repository.name),
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(word),
          ),
      )
      .slice(0, 8);
    const fresh = !panel;
    input = target;
    trigger = { start };
    options = next;
    selected = 0;
    if (fresh) {
      panel = document.createElement('div');
      panel.className = 'task-mention-picker';
      panel.setAttribute('popover', 'manual');
      (target.closest('dialog') || document.body).append(panel);
      panel.showPopover();
      panel.addEventListener('pointerdown', (event) => event.preventDefault());
      panel.addEventListener('click', (event) => {
        const option = event.target.closest('[data-mention-index]');
        if (option) choose(Number(option.dataset.mentionIndex));
      });
    }
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'task-mention-options');
    paint();
    if (fresh) animateSurface(panel, 'dropdown');
  }
  document.addEventListener('input', (event) => {
    if (accepts(event.target)) {
      syncTaskComposer(event.target);
      update(event.target);
    }
  });
  document.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-mention]');
    if (remove) {
      const target = remove.closest('form').querySelector('textarea');
      save(
        target,
        composerMentions(target).filter((m) => m.id !== remove.dataset.removeMention),
      );
      syncTaskComposer(target);
      target.focus();
      return;
    }
    if (accepts(event.target)) update(event.target);
    else if (panel && !panel.contains(event.target)) close();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (!panel || event.target !== input || event.isComposing) return;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        close();
        return;
      }
      if (event.key === 'Tab' && !options.length) {
        close();
        return;
      }
      if (
        ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === 'Escape') return close();
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (options.length) choose(selected);
          return;
        }
        selected =
          (selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
          Math.max(1, options.length);
        paint();
      }
    },
    true,
  );
  document.addEventListener(
    'close',
    (event) => {
      if (event.target.contains?.(input)) close();
    },
    true,
  );
  document.addEventListener('scroll', position, true);
  window.addEventListener('resize', () => {
    document.querySelectorAll('#workspace-request').forEach(syncTaskComposer);
    position();
  });
  new MutationObserver(() =>
    document
      .querySelectorAll('#workspace-request,#chat-edit-question[data-task-mentions]')
      .forEach(syncTaskComposer),
  ).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', close);
  document.addEventListener('focusin', (event) => {
    if (panel && event.target !== input && !panel.contains(event.target)) close();
  });
}
