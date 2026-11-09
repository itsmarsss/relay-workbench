import { lowMotion } from './motion-preferences.js';
const states = new WeakMap();
const active = new Map();
export function syncTabMotion(root = document) {
  for (const bar of root.querySelectorAll('.relay-tabs')) {
    const selected = bar.querySelector('button[aria-selected="true"],button[aria-pressed="true"]');
    const indicator = bar.querySelector('[data-tab-indicator]');
    if (!selected || !indicator) continue;
    // Keep restored/deep-linked selections visible without moving the document.
    if (selected.offsetLeft < bar.scrollLeft) bar.scrollLeft = selected.offsetLeft;
    else if (selected.offsetLeft + selected.offsetWidth > bar.scrollLeft + bar.clientWidth)
      bar.scrollLeft = selected.offsetLeft + selected.offsetWidth - bar.clientWidth;
    const box = selected.getBoundingClientRect(),
      parent = bar.getBoundingClientRect();
    const next = {
      key: selected.dataset.tab ?? selected.dataset.filter,
      x: box.left - parent.left + bar.scrollLeft,
      width: box.width,
    };
    const prior = states.get(bar);
    if (
      prior?.key === next.key &&
      active.has(bar) &&
      Math.abs(prior.x - next.x) < 1 &&
      Math.abs(prior.width - next.width) < 1
    )
      continue;
    const current = indicator.getBoundingClientRect();
    active.get(bar)?.cancel();
    active.delete(bar);
    states.set(bar, next);
    indicator.style.width = `${next.width}px`;
    indicator.style.transform = `translateX(${next.x}px)`;
    if (prior && prior.key !== next.key && !lowMotion() && window.Motion) {
      const animation = window.Motion.animate(
        indicator,
        {
          transform: [
            `translateX(${current.left - parent.left + bar.scrollLeft}px)`,
            `translateX(${next.x}px)`,
          ],
          width: [current.width, next.width],
        },
        { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
      );
      active.set(bar, animation);
      animation.then(() => {
        if (active.get(bar) === animation) {
          active.delete(bar);
          animation.cancel();
          indicator.style.width = `${next.width}px`;
          indicator.style.transform = `translateX(${next.x}px)`;
        }
      });
    }
  }
  for (const [bar, animation] of active)
    if (!bar.isConnected) {
      animation.cancel();
      active.delete(bar);
    }
}
window.addEventListener('resize', () => syncTabMotion());
document.addEventListener('relay-motion-change', () => {
  if (!lowMotion()) return;
  for (const animation of active.values()) animation.cancel();
  active.clear();
  syncTabMotion();
});
