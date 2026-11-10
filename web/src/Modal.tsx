import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';
export function Modal({
  title,
  onClose,
  onSubmit,
  children,
  footer,
  returnFocus,
  className = '',
}: {
  title: string;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer?: ReactNode;
  returnFocus?: HTMLElement | null;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
      className={`editor-modal ${className}`.trim()}
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
