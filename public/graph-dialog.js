// Keep keyboard navigation and assistive technology inside the graph overlay.
let active;
let opener;
const masked = new Set();
const focusable = (root) =>
  [
    ...root.querySelectorAll(
      'button:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (node) => node.checkVisibility({ checkVisibilityCSS: true }) && !node.closest('[inert]'),
  );
function release() {
  for (const node of masked) node.inert = false;
  masked.clear();
}
export function syncGraphDialog() {
  const graph = document.querySelector('.graph-dialog');
  release();
  if (!graph) {
    if (active && opener?.isConnected) opener.focus({ preventScroll: true });
    active = null;
    opener = null;
    return;
  }
  if (!active) opener = document.activeElement;
  active = graph;
  for (let node = graph; node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (
        sibling === node ||
        !(sibling instanceof HTMLElement) ||
        sibling.inert ||
        ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)
      )
        continue;
      sibling.inert = true;
      masked.add(sibling);
    }
    if (node.parentElement === document.body) break;
  }
  if (!graph.contains(document.activeElement))
    graph.querySelector('.graph-close').focus({ preventScroll: true });
}
document.addEventListener(
  'keydown',
  (event) => {
    if (!active?.isConnected || event.key !== 'Tab') return;
    const items = focusable(active);
    const index = items.indexOf(document.activeElement);
    if (
      index < 0 ||
      (event.shiftKey && index === 0) ||
      (!event.shiftKey && index === items.length - 1)
    ) {
      event.preventDefault();
      (event.shiftKey ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    }
  },
  true,
);
