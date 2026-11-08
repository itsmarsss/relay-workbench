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
  const toggle = document.getElementById('low-motion');
  if (toggle) toggle.checked = lowMotion();
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
export function animateSurface(element, kind = 'page') {
  if (!element || lowMotion() || !window.Motion) return;
  const transforms = {
    page: ['translateY(10px)', 'translateY(0px)'],
    drawer: ['translateX(24px)', 'translateX(0px)'],
    dialog: ['translateY(12px) scale(.98)', 'translateY(0px) scale(1)'],
    content: ['translateY(-5px)', 'translateY(0px)'],
  };
  window.Motion.animate(
    element,
    { opacity: [0, 1], transform: transforms[kind] || transforms.page },
    { duration: kind === 'drawer' ? 0.26 : 0.22, ease: [0.22, 1, 0.36, 1] },
  );
}
const seen = new WeakSet();
export function animateEntrances(root) {
  for (const element of root.querySelectorAll(
    '.page-heading,.task-heading,.side-chat-drawer,.approval-panel,.orchestrator-intro',
  )) {
    if (seen.has(element)) continue;
    seen.add(element);
    animateSurface(element, element.matches('.side-chat-drawer') ? 'drawer' : 'page');
  }
}
document.addEventListener(
  'toggle',
  (event) => {
    if (event.target.tagName !== 'DETAILS' || !event.target.open || lowMotion()) return;
    for (const child of event.target.children)
      if (child.tagName !== 'SUMMARY') animateSurface(child, 'content');
  },
  true,
);
apply();
