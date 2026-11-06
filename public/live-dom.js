// Reconcile trusted, locally rendered markup without replacing active controls.
function key(node) {
  if (node.nodeType !== 1) return null;
  for (const attribute of ['id', 'data-event-key', 'data-event-seq', 'data-editor'])
    if (node.hasAttribute(attribute))
      return `${node.tagName}:${attribute}:${node.getAttribute(attribute)}`;
  if (node.tagName === 'DETAILS')
    return `DETAILS:${node.className}:${node.querySelector('summary')?.textContent.replace(/\d+/g, '').trim()}`;
  if (node.dataset.action)
    return `${node.tagName}:action:${node.dataset.action}:${node.dataset.run ?? node.dataset.id ?? node.dataset.tab ?? ''}`;
  return null;
}
function compatible(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
}
function patch(node, next) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  // xterm owns this subtree and its input/selection/scroll state.
  if (node.hasAttribute('data-browser-terminal')) return;
  for (const attribute of [...node.attributes]) {
    if (node.tagName === 'DETAILS' && attribute.name === 'open') continue;
    if (!next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (node.tagName === 'DETAILS' && attribute.name === 'open') continue;
    if (node.getAttribute(attribute.name) !== attribute.value)
      node.setAttribute(attribute.name, attribute.value);
  }
  reconcile(node, next);
}
function reconcile(parent, next) {
  const original = [...parent.childNodes];
  const keyed = new Map(original.filter((node) => key(node)).map((node) => [key(node), node]));
  const used = new Set();
  let cursor = parent.firstChild;
  for (const wanted of [...next.childNodes]) {
    const identity = key(wanted);
    let node = identity ? keyed.get(identity) : cursor;
    if (!node || used.has(node) || !compatible(node, wanted)) node = null;
    if (!node) {
      node = wanted.cloneNode(true);
      parent.insertBefore(node, cursor);
    } else {
      if (node !== cursor) parent.insertBefore(node, cursor);
      patch(node, wanted);
    }
    used.add(node);
    cursor = node.nextSibling;
  }
  for (const node of original) if (!used.has(node)) node.remove();
}
export function updateLiveDOM(root, html, scope) {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = html;
  if (root.dataset.renderScope !== scope) {
    root.replaceChildren(template.content);
    root.dataset.renderScope = scope;
    return;
  }
  const view = root.ownerDocument.defaultView;
  const scroll = { x: view.scrollX, y: view.scrollY };
  const positions = [...root.querySelectorAll('*')]
    .filter((node) => node.scrollTop || node.scrollLeft)
    .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
  const anchors = [...root.querySelectorAll('[data-event-seq], [data-event-key], details, h2, h3')]
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height && rect.top >= 0 && rect.top < view.innerHeight)
    .sort((a, b) => a.rect.top - b.rect.top);
  const anchor = anchors[0];
  reconcile(root, template.content);
  for (const { node, top, left } of positions) {
    if (node.isConnected) {
      node.scrollTop = top;
      node.scrollLeft = left;
    }
  }
  // Normalize any browser anchoring performed during layout before measuring.
  view.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
  const shift = anchor?.node.isConnected
    ? anchor.node.getBoundingClientRect().top - anchor.rect.top
    : 0;
  view.scrollTo({ left: scroll.x, top: scroll.y + shift, behavior: 'instant' });
}
