import { lowMotion } from './motion-preferences.js';
import { icon } from './ui.js';
const key = 'relay-sidebar';
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(key) || '{}') || {};
} catch {}
let width = Math.max(208, Math.min(340, Number(saved.width) || 232));
let collapsed = saved.collapsed === true;
let mobileExpanded = false;
const narrow = matchMedia('(max-width: 980px)');
const style = document.createElement('style');
style.nonce = document.querySelector('meta[name=relay-style-nonce]')?.content || '';
document.head.append(style);
function persist() {
  try {
    localStorage.setItem(key, JSON.stringify({ width, collapsed }));
  } catch {}
}
const layoutAnimations = new Map();
let appliedWidth = width;
function apply(animate = false) {
  if (
    !animate &&
    layoutAnimations.size &&
    width === appliedWidth &&
    !document.documentElement.classList.contains('sidebar-resizing')
  )
    return;
  const nodes = [...document.querySelectorAll('.sidebar,.main-shell')];
  const before = nodes.map((node) => node.getBoundingClientRect());
  for (const animation of layoutAnimations.values()) animation.cancel();
  layoutAnimations.clear();
  const compact = narrow.matches ? !mobileExpanded : collapsed;
  document.documentElement.dataset.sidebar = compact ? 'collapsed' : 'expanded';
  style.textContent = `:root { --sidebar-width: ${width}px; }`;
  appliedWidth = width;
  if (animate && !lowMotion() && window.Motion && !narrow.matches) {
    nodes.forEach((node, index) => {
      const after = node.getBoundingClientRect();
      const properties = node.matches('.sidebar')
        ? { width: [before[index].width, after.width] }
        : {
            width: [before[index].width, after.width],
            marginLeft: [before[index].left, after.left],
          };
      const animation = window.Motion.animate(node, properties, {
        duration: 0.24,
        ease: [0.22, 1, 0.36, 1],
      });
      layoutAnimations.set(node, animation);
      animation.then(() => {
        if (layoutAnimations.get(node) !== animation) return;
        layoutAnimations.delete(node);
        animation.cancel();
        node.style.removeProperty('width');
        node.style.removeProperty('margin-left');
      });
    });
  }
  const toggle = document.querySelector('[data-sidebar-toggle]');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!compact));
    toggle.setAttribute('aria-label', compact ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = compact ? 'Expand sidebar' : 'Collapse sidebar';
  }
  const handle = document.querySelector('.sidebar-resize');
  handle?.setAttribute('aria-valuenow', String(width));
}
export function sidebarControls() {
  return `<button type="button" class="sidebar-toggle" data-sidebar-toggle aria-controls="workspace-navigation" aria-label="Collapse sidebar" aria-expanded="true">${icon('sidebar')}</button><div class="sidebar-resize" role="separator" tabindex="0" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin="208" aria-valuemax="340" aria-valuenow="${width}" title="Drag to resize · arrow keys to adjust · double-click to reset"></div>`;
}
export const syncSidebar = apply;
document.addEventListener('relay-motion-change', () => {
  if (!lowMotion()) return;
  for (const [node, animation] of layoutAnimations) {
    animation.cancel();
    node.style.removeProperty('width');
    node.style.removeProperty('margin-left');
  }
  layoutAnimations.clear();
  apply();
});
narrow.addEventListener('change', () => {
  mobileExpanded = false;
  apply();
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-sidebar-toggle]')) {
    if (narrow.matches) mobileExpanded = !mobileExpanded;
    else collapsed = !collapsed;
    persist();
    apply(true);
  } else if (
    mobileExpanded &&
    (event.target.closest('.main-shell') || event.target.closest('.nav-item'))
  ) {
    mobileExpanded = false;
    apply();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && mobileExpanded) {
    mobileExpanded = false;
    apply();
    document.querySelector('[data-sidebar-toggle]')?.focus();
  }
  if (!event.target.matches('.sidebar-resize')) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  width =
    event.key === 'Home'
      ? 208
      : event.key === 'End'
        ? 340
        : Math.max(208, Math.min(340, width + (event.key === 'ArrowLeft' ? -16 : 16)));
  persist();
  apply();
});
document.addEventListener('dblclick', (event) => {
  if (event.target.matches('.sidebar-resize')) {
    width = 232;
    persist();
    apply();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.matches('.sidebar-resize') || event.button !== 0) return;
  event.preventDefault();
  const handle = event.target,
    start = width,
    x = event.clientX;
  handle.setPointerCapture(event.pointerId);
  document.documentElement.classList.add('sidebar-resizing');
  const move = (e) => {
    width = Math.max(208, Math.min(340, start + e.clientX - x));
    apply();
  };
  const finish = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    handle.removeEventListener('lostpointercapture', finish);
    document.documentElement.classList.remove('sidebar-resizing');
    persist();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
});
apply();
