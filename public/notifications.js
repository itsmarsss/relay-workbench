function element() {
  return document.getElementById('toast');
}
export function syncToastLayer() {
  const toast = element();
  if (!toast) return;
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  const host = dialog || document.body;
  if (toast.parentElement !== host) {
    if (toast.matches(':popover-open')) toast.hidePopover();
    host.append(toast);
  }
  if (toast.classList.contains('show') && !toast.matches(':popover-open')) toast.showPopover();
}
export function notify(message, error = false) {
  const toast = element();
  toast.setAttribute('popover', 'manual');
  toast.textContent = message;
  toast.className = error ? 'show error' : 'show';
  clearTimeout(toast.timer);
  syncToastLayer();
  toast.timer = setTimeout(() => {
    toast.className = '';
    if (toast.matches(':popover-open')) toast.hidePopover();
  }, 6500);
}
// Keep one live region accessible inside the active dialog, and preserve it on close.
document.addEventListener(
  'close',
  (event) => {
    if (event.target.tagName === 'DIALOG') syncToastLayer();
  },
  true,
);
document.addEventListener(
  'toggle',
  (event) => {
    if (event.target.tagName === 'DIALOG') syncToastLayer();
  },
  true,
);
