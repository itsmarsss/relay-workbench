import { escapeHTML as e } from './escape.js';

export function installTaskContextMenu({ select, onError }) {
  const menu = document.createElement('div');
  menu.className = 'task-context-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Task actions');
  document.body.append(menu);
  let target;
  const close = () => menu.hidePopover();
  function show(event, keyboard = false) {
    const card = event.target.closest('[data-action="open-task"][data-id]');
    if (!card || event.target.closest('a,input,textarea,[contenteditable]')) return;
    event.preventDefault();
    target = card;
    const id = card.dataset.id;
    menu.innerHTML = [
      ['open', 'Open task'],
      ['copy', 'Copy task link'],
      ['duplicate', 'Duplicate task'],
      ['delete', 'Delete task'],
    ]
      .map(
        ([action, label]) =>
          `<button type="button" role="menuitem" data-menu-action="${action}" data-task-id="${e(id)}"${action === 'delete' ? ' class="danger"' : ''}>${label}</button>`,
      )
      .join('');
    menu.showPopover();
    const box = card.getBoundingClientRect();
    menu.style.left =
      Math.max(
        8,
        Math.min(keyboard ? box.left : event.clientX, innerWidth - menu.offsetWidth - 8),
      ) + 'px';
    menu.style.top =
      Math.max(
        8,
        Math.min(keyboard ? box.bottom : event.clientY, innerHeight - menu.offsetHeight - 8),
      ) + 'px';
    menu.querySelector('button').focus();
  }
  document.addEventListener('contextmenu', show);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) show(event, true);
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('button')];
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      items[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      ].focus();
    }
    if (event.key === 'Tab' || event.key === 'Escape') {
      close();
      if (event.key === 'Escape') {
        event.preventDefault();
        target?.focus();
      }
    }
  });
  menu.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-menu-action]');
    if (!button) return;
    close();
    try {
      await select(button.dataset.menuAction, button.dataset.taskId);
    } catch (error) {
      onError(error);
    }
  });
  window.addEventListener('resize', close);
  document.addEventListener(
    'scroll',
    (event) => {
      if (!menu.contains(event.target)) close();
    },
    true,
  );
}
