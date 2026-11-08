import { fitWindow, resizeWindow } from './window-geometry.js';
const key = 'relay-chat-window';
let geometry;
try {
  geometry = JSON.parse(localStorage.getItem(key) || 'null');
} catch {}
if (geometry && !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(geometry[key])))
  geometry = null;
const style = document.createElement('style');
style.nonce = document.querySelector('meta[name=relay-style-nonce]')?.content || '';
document.head.append(style);
const viewport = () => ({ width: innerWidth, height: innerHeight });
function apply() {
  if (!geometry || innerWidth <= 700) {
    style.textContent = '';
    return;
  }
  geometry = fitWindow(geometry, viewport());
  style.textContent = `.side-chat-drawer {left:${geometry.x}px;top:${geometry.y}px;width:${geometry.width}px;height:${geometry.height}px;right:auto;bottom:auto;}`;
}
function save() {
  try {
    localStorage.setItem(key, JSON.stringify(geometry));
  } catch {}
}
function reset() {
  geometry = null;
  apply();
  save();
}
window.addEventListener('resize', apply);
document.addEventListener('dblclick', (event) => {
  if (event.target.closest('[data-chat-drag]') && !event.target.closest('button')) reset();
});
document.addEventListener('keydown', (event) => {
  if (
    !event.target.matches('.chat-resize') ||
    !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)
  )
    return;
  event.preventDefault();
  if (event.key === 'Home') {
    reset();
    return;
  }
  const r = event.target.closest('.side-chat-drawer').getBoundingClientRect();
  geometry = resizeWindow(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0,
    event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0,
    'se',
    viewport(),
  );
  apply();
  save();
});
document.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('[data-chat-resize],[data-chat-drag]');
  if (!handle || event.button !== 0 || innerWidth <= 700 || event.target.closest('[data-action]'))
    return;
  event.preventDefault();
  const surface = handle.closest('.side-chat-drawer');
  for (const animation of surface.getAnimations()) animation.finish();
  const r = surface.getBoundingClientRect();
  const start = fitWindow({ x: r.x, y: r.y, width: r.width, height: r.height }, viewport());
  const x = event.clientX,
    y = event.clientY,
    edge = handle.dataset.chatResize;
  handle.setPointerCapture(event.pointerId);
  document.documentElement.setAttribute('data-chat-interacting', edge || 'move');
  const move = (e) => {
    geometry = edge
      ? resizeWindow(start, e.clientX - x, e.clientY - y, edge, viewport())
      : fitWindow({ ...start, x: start.x + e.clientX - x, y: start.y + e.clientY - y }, viewport());
    apply();
  };
  const finish = () => {
    handle.removeEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      handle.removeEventListener(type, finish);
    document.documentElement.removeAttribute('data-chat-interacting');
    save();
    document.dispatchEvent(new CustomEvent('relay-chat-settled'));
  };
  handle.addEventListener('pointermove', move);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    handle.addEventListener(type, finish);
});
apply();
