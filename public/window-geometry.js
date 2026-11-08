const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function fitWindow(rect, viewport) {
  const width = clamp(rect.width, Math.min(340, viewport.width - 24), viewport.width - 24);
  const height = clamp(rect.height, Math.min(300, viewport.height - 24), viewport.height - 24);
  return {
    width,
    height,
    x: clamp(rect.x, 12, viewport.width - width - 12),
    y: clamp(rect.y, 12, viewport.height - height - 12),
  };
}
export function resizeWindow(start, dx, dy, edge, viewport) {
  const minWidth = Math.min(340, viewport.width - 24),
    minHeight = Math.min(300, viewport.height - 24);
  let left = start.x,
    top = start.y,
    right = start.x + start.width,
    bottom = start.y + start.height;
  if (edge.includes('w')) left = clamp(left + dx, 12, right - minWidth);
  if (edge.includes('e')) right = clamp(right + dx, left + minWidth, viewport.width - 12);
  if (edge.includes('n')) top = clamp(top + dy, 12, bottom - minHeight);
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minHeight, viewport.height - 12);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
