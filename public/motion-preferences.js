const key = 'relay-low-motion';
const exits = new Map();
const disclosures = new Map();
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
  if (lowMotion()) {
    for (const [node, entry] of disclosures) finishDisclosure(node, entry);
    for (const [node, entry] of exits) {
      exits.delete(node);
      entry.animation.cancel();
      entry.complete();
    }
    for (const animation of document.getAnimations()) animation.cancel();
  }
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
  if (!element) return;
  const pending = exits.get(element);
  if (pending) {
    exits.delete(element);
    pending.animation.cancel();
  }
  if (lowMotion() || !window.Motion) return;
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
const scopes = new WeakMap();
export function animateEntrances(root) {
  const scope = root.dataset.motionScope ?? root.dataset.renderScope;
  const previous = scopes.get(root);
  if (scope !== previous) {
    scopes.set(root, scope);
    const sameTask =
      previous?.startsWith('task:') &&
      scope?.startsWith(previous.split(':').slice(0, 2).join(':') + ':');
    const targets = sameTask ? root.querySelectorAll('.detail-content') : root.children;
    for (const node of targets) {
      if (node.matches('.task-layout')) {
        for (const content of node.querySelectorAll(
          '.task-center > *, .task-context > .context-card',
        ))
          animateSurface(content, 'page');
      } else if (!node.matches('.side-chat-drawer')) animateSurface(node, 'page');
    }
  }
  for (const element of root.querySelectorAll('.side-chat-drawer,.approval-panel,.execution-map')) {
    if (seen.has(element)) continue;
    seen.add(element);
    animateSurface(element, element.matches('.side-chat-drawer') ? 'drawer' : 'content');
  }
}
export function animateExit(element, kind, complete) {
  if (!element || lowMotion() || !window.Motion) {
    complete();
    return;
  }
  if (exits.has(element)) return;
  const animation = window.Motion.animate(
    element,
    {
      opacity: [1, 0],
      transform:
        kind === 'drawer'
          ? ['translateX(0px)', 'translateX(18px)']
          : ['translateY(0px) scale(1)', 'translateY(6px) scale(.99)'],
    },
    { duration: 0.16, ease: [0.4, 0, 1, 1] },
  );
  const entry = { animation, complete };
  exits.set(element, entry);
  animation.then(() => {
    if (exits.get(element) === entry) {
      exits.delete(element);
      complete();
    }
  });
}
function finishDisclosure(node, entry) {
  if (disclosures.get(node) !== entry) return;
  disclosures.delete(node);
  node.open = entry.open;
  entry.animation.cancel();
  node.style.removeProperty('height');
  node.style.removeProperty('overflow');
}
document.addEventListener(
  'click',
  (event) => {
    const summary = event.target.closest('summary');
    if (
      !summary ||
      summary.parentElement.tagName !== 'DETAILS' ||
      event.target.closest('a,button,input,select') ||
      lowMotion() ||
      !window.Motion
    )
      return;
    event.preventDefault();
    const node = summary.parentElement,
      prior = disclosures.get(node),
      open = prior ? !prior.open : !node.open;
    const from = node.getBoundingClientRect().height;
    if (prior) {
      disclosures.delete(node);
      prior.animation.cancel();
    }
    node.style.removeProperty('height');
    node.open = open;
    const to = node.getBoundingClientRect().height;
    node.open = true;
    node.style.overflow = 'hidden';
    const animation = window.Motion.animate(
      node,
      { height: [from, to] },
      { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
    );
    const entry = { open, animation };
    disclosures.set(node, entry);
    animation.then(() => finishDisclosure(node, entry));
  },
  true,
);
document.addEventListener(
  'toggle',
  (event) => {
    if (event.target.id === 'toast' && event.newState === 'open')
      animateSurface(event.target, 'content');
  },
  true,
);
apply();
