const key = 'relay-low-motion';
const system = matchMedia('(prefers-reduced-motion: reduce)');
let preference;
try {
  preference = localStorage.getItem(key);
} catch {}
export function lowMotion() {
  return preference === 'true' || system.matches;
}
function apply() {
  document.documentElement.toggleAttribute('data-low-motion', lowMotion());
  if (lowMotion()) for (const animation of document.getAnimations()) animation.cancel();
}
export function setLowMotion(value) {
  preference = String(value);
  try {
    localStorage.setItem(key, preference);
  } catch {}
  apply();
}
system.addEventListener('change', apply);
window.addEventListener('storage', (event) => {
  if (event.key === key) {
    preference = event.newValue;
    apply();
  }
});
const seen = new WeakSet();
export function animateEntrances(root) {
  for (const element of root.querySelectorAll(
    '.page-heading, .side-chat-drawer, .approval-panel',
  )) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (!lowMotion() && window.Motion)
      window.Motion.animate(element, { opacity: [0, 1] }, { duration: 0.16 });
  }
}
apply();
