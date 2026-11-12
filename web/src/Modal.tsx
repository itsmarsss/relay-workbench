import { useEffect, useLayoutEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';
type Scrolled = [Element, number, number][];
// The server render has no layout to measure, and React warns about a layout effect there.
const useLeaveEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;
// React removes a closed dialog at once, so it cannot animate out in place. The removed element is
// shown again as an inert popover instead: it joins the top layer above any dialog still open,
// takes no focus and blocks nothing, and removes itself once its closing animation has run.
function leave(element: HTMLDialogElement, box: DOMRect, scrolled: Scrolled) {
  if (
    element.isConnected ||
    typeof element.showPopover !== 'function' ||
    document.documentElement.dataset.lowMotion === 'true' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return;
  element.removeAttribute('open');
  element.removeAttribute('aria-label');
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('popover', 'manual');
  element.inert = true;
  element.classList.add('is-leaving');
  Object.assign(element.style, {
    inset: 'auto',
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: '0',
  });
  document.body.append(element);
  try {
    element.showPopover();
  } catch {
    element.remove();
    return;
  }
  for (const [node, top, left] of scrolled) node.scrollTo(left, top);
  const done = () => element.remove();
  element.addEventListener('animationend', (event) => {
    if (event.target === element) done();
  });
  setTimeout(done, 400);
}
export function Modal({
  title,
  onClose,
  onSubmit,
  children,
  footer,
  returnFocus,
  className = '',
  variant = 'dialog',
}: {
  title: string;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer?: ReactNode;
  returnFocus?: HTMLElement | null;
  className?: string;
  // A drawer is the same modal dialog docked to the right edge at full height.
  variant?: 'dialog' | 'drawer';
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    pressedBackdrop = useRef(false);
  useLeaveEffect(() => {
    const element = dialog.current;
    return () => {
      if (!element) return;
      const box = element.getBoundingClientRect();
      const scrolled: Scrolled = [...element.querySelectorAll('*')]
        .filter((node) => node.scrollTop || node.scrollLeft)
        .map((node) => [node, node.scrollTop, node.scrollLeft]);
      // By the time this runs React has taken the element out of the page.
      queueMicrotask(() => leave(element, box, scrolled));
    };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    const previous =
      returnFocus ||
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (element && !element.open) element.showModal();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const body = (
    <>
      <header>
        <h2>{title}</h2>
        <button type="button" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="editor-modal-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </>
  );
  const content = (
    <dialog
      ref={dialog}
      className={`editor-modal ${variant === 'drawer' ? 'editor-drawer' : ''} ${className}`
        .replace(/\s+/g, ' ')
        .trim()}
      // Pressing the dimmed page beside a drawer closes it, unless that would drop a form's edits.
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (
          variant === 'drawer' &&
          !onSubmit &&
          pressedBackdrop.current &&
          event.target === event.currentTarget
        )
          onClose();
      }}
      onKeyDown={(event) => {
        if (
          event.key !== 'Tab' ||
          event.defaultPrevented ||
          (event.target as HTMLElement).closest('dialog') !== event.currentTarget
        )
          return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(':disabled') &&
            !element.closest('[inert]') &&
            element.getClientRects().length > 0,
        );
        const target = event.shiftKey ? controls.at(-1) : controls[0];
        if (
          !controls.includes(document.activeElement as HTMLElement) ||
          document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))
        ) {
          event.preventDefault();
          target?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // Escape typed into a terminal is for the program running there.
        if (document.activeElement?.closest('.live-terminal-screen')) return;
        onClose();
      }}
      aria-label={title}
    >
      {onSubmit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSubmit?.(event);
          }}
        >
          {body}
        </form>
      ) : (
        <div className="modal-content">{body}</div>
      )}
    </dialog>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
