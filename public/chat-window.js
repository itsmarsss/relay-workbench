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
function apply() {
  if (!geometry || innerWidth < 700) {
    style.textContent = '';
    return;
  }
  const width = Math.max(340, Math.min(innerWidth - 24, geometry.width));
  const height = Math.max(300, Math.min(innerHeight - 24, geometry.height));
  geometry = {
    width,
    height,
    x: Math.max(12, Math.min(innerWidth - width - 12, geometry.x)),
    y: Math.max(12, Math.min(innerHeight - height - 12, geometry.y)),
  };
  style.textContent = `.side-chat-drawer { left:${geometry.x}px; top:${geometry.y}px; width:${width}px; height:${height}px; right:auto; bottom:auto; }`;
}
function save() {
  try {
    localStorage.setItem(key, JSON.stringify(geometry));
  } catch {}
}
window.addEventListener('resize', apply);
document.addEventListener('dblclick', (event) => {
  if (!event.target.closest('[data-chat-drag]') || event.target.closest('button')) return;
  geometry = null;
  apply();
  save();
});
document.addEventListener('keydown', (event) => {
  if (
    !event.target.matches('.chat-resize') ||
    !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)
  )
    return;
  event.preventDefault();
  if (event.key === 'Home') {
    geometry = null;
    apply();
    save();
    return;
  }
  const r = event.target.closest('.side-chat-drawer').getBoundingClientRect();
  geometry = {
    x: r.x,
    y: r.y,
    width: r.width + (event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0),
    height: r.height + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0),
  };
  apply();
  save();
});
document.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('.chat-resize, [data-chat-drag]');
  if (!handle || event.button !== 0 || innerWidth < 700 || event.target.closest('[data-action]'))
    return;
  event.preventDefault();
  const r = handle.closest('.side-chat-drawer').getBoundingClientRect();
  const start = { x: r.x, y: r.y, width: r.width, height: r.height };
  const x = event.clientX,
    y = event.clientY,
    resize = handle.matches('.chat-resize');
  handle.setPointerCapture(event.pointerId);
  const move = (e) => {
    geometry = resize
      ? { ...start, width: start.width + e.clientX - x, height: start.height + e.clientY - y }
      : { ...start, x: start.x + e.clientX - x, y: start.y + e.clientY - y };
    apply();
  };
  const finish = () => {
    handle.removeEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      handle.removeEventListener(type, finish);
    save();
  };
  handle.addEventListener('pointermove', move);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    handle.addEventListener(type, finish);
});
apply();
