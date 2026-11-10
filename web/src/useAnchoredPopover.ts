import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// Position the actual content against its field, including while Motion moves it.
// The portal keeps menus outside scrolling panes; modal menus stay in their dialog.
export function useAnchoredPopover(
  open: boolean,
  anchor: RefObject<HTMLElement>,
  layer: RefObject<HTMLElement>,
  dismiss: () => void,
  { minWidth = 220, maxHeight = 320, gap = 6 } = {},
) {
  const onDismiss = useRef(dismiss);
  onDismiss.current = dismiss;
  useClientLayoutEffect(() => {
    if (!open) return;
    const field = anchor.current,
      popup = layer.current;
    if (!field || !popup) return;
    let frame = 0,
      dirty = true,
      previous = '';
    function place() {
      const rect = field!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft || 0) + 8,
        topEdge = (viewport?.offsetTop || 0) + 8,
        rightEdge = leftEdge + (viewport?.width || innerWidth) - 16,
        bottomEdge = topEdge + (viewport?.height || innerHeight) - 16;
      if (
        !field!.isConnected ||
        rect.bottom <= topEdge ||
        rect.top >= bottomEdge ||
        rect.right <= leftEdge ||
        rect.left >= rightEdge
      ) {
        onDismiss.current();
        return;
      }
      for (
        let parent = field!.parentElement;
        parent && parent !== document.body;
        parent = parent.parentElement
      ) {
        const css = getComputedStyle(parent);
        const clipX = /(auto|scroll|hidden|clip)/.test(css.overflowX),
          clipY = /(auto|scroll|hidden|clip)/.test(css.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = parent.getBoundingClientRect();
        if (
          (clipY && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) ||
          (clipX && (rect.right <= bounds.left || rect.left >= bounds.right))
        ) {
          onDismiss.current();
          return;
        }
      }
      const width = Math.min(Math.max(rect.width, minWidth), rightEdge - leftEdge);
      popup!.style.width = `${width}px`;
      popup!.style.maxHeight = `${maxHeight}px`;
      const height = popup!.getBoundingClientRect().height;
      const below = Math.max(0, bottomEdge - rect.bottom - gap),
        above = Math.max(0, rect.top - topEdge - gap);
      const side = below >= height || below >= above ? 'bottom' : 'top';
      popup!.dataset.side = side;
      popup!.style.left = `${Math.max(leftEdge, Math.min(rect.left, rightEdge - width))}px`;
      popup!.style.top = side === 'bottom' ? `${rect.bottom + gap}px` : 'auto';
      popup!.style.bottom = side === 'top' ? `${innerHeight - rect.top + gap}px` : 'auto';
      popup!.style.maxHeight = `${Math.min(maxHeight, side === 'bottom' ? below : above)}px`;
      popup!.style.visibility = 'visible';
    }
    function track() {
      const r = field!.getBoundingClientRect();
      const next = `${r.x},${r.y},${r.width},${r.height},${innerWidth},${innerHeight}`;
      if (dirty || previous !== next) {
        dirty = false;
        previous = next;
        place();
      }
      frame = requestAnimationFrame(track);
    }
    const changed = () => {
      dirty = true;
    };
    const observer = new ResizeObserver(changed);
    observer.observe(popup);
    observer.observe(field);
    window.visualViewport?.addEventListener('resize', changed);
    window.visualViewport?.addEventListener('scroll', changed);
    place();
    frame = requestAnimationFrame(track);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.visualViewport?.removeEventListener('resize', changed);
      window.visualViewport?.removeEventListener('scroll', changed);
    };
  }, [open, anchor, layer, minWidth, maxHeight, gap]);
}

export function revealOption(list: HTMLElement | null, option: HTMLElement | null) {
  if (!list || !option) return;
  const bounds = list.getBoundingClientRect(),
    row = option.getBoundingClientRect();
  if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
  else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
}
