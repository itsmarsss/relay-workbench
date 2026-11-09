import { activeMentions } from './task-mentions.js';
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
  return activeMentions(input.value, composerMentions(input)).map(({ id, label }) => ({
    id,
    label,
  }));
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
    const values = composerMentions(input).filter((m) => m.id !== task.id || m.label !== label);
    values.push({ id: task.id, label });
    save(input, values);
    const target = input;
    target.setRangeText('@' + label + ' ', trigger.start, target.selectionStart, 'end');
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
    if (accepts(event.target)) update(event.target);
  });
  document.addEventListener('click', (event) => {
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
  window.addEventListener('resize', position);
  window.addEventListener('hashchange', close);
  document.addEventListener('focusin', (event) => {
    if (panel && event.target !== input && !panel.contains(event.target)) close();
  });
}
