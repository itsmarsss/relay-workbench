import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    send: (
      <>
        <path d="m3 11 18-8-8 18-2-8-8-2Z" />
        <path d="m11 13 10-10" />
      </>
    ),
    resize: (
      <>
        <path d="M4 4h5M4 4v5m16 11h-5m5 0v-5M4 4l6 6m10 10-6-6" />
      </>
    ),
    relay: (
      <>
        <path d="m4 7 8-4 8 4-8 4-8-4Zm0 5 8 4 8-4M4 17l8 4 8-4" />
        <path d="M12 11v10" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    tasks: (
      <>
        <rect x="4" y="4" width="6" height="16" rx="1" />
        <rect x="14" y="4" width="6" height="10" rx="1" />
      </>
    ),
    chat: <path d="M20 11a8 8 0 0 1-8 8H8l-5 2 1-5a8 8 0 1 1 16-5Z" />,
    inbox: (
      <>
        <path d="M4 4h16l2 12v4H2v-4L4 4Z" />
        <path d="M2 14h6l2 3h4l2-3h6" />
      </>
    ),
    repository: (
      <>
        <path d="M5 3h13a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Z" />
        <path d="M3 17h17M7 7h9M7 10h6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3H9Z" />
      </>
    ),
    memory: (
      <>
        <rect x="5" y="5" width="14" height="14" rx="2" />
        <path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4M9 9h6v6H9z" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
      </>
    ),
    moon: <path d="M20 15.5A9 9 0 0 1 8.5 4a9 9 0 1 0 11.5 11.5Z" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    graph: (
      <>
        <rect x="8" y="2" width="8" height="5" rx="1" />
        <rect x="1" y="17" width="8" height="5" rx="1" />
        <rect x="15" y="17" width="8" height="5" rx="1" />
        <path d="M12 7v5H5v5m7-5h7v5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.tasks}
    </svg>
  );
}
export function Select({
  label,
  value,
  options,
  onChange,
  custom = false,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; detail?: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  custom?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [index, setIndex] = useState(0),
    [position, setPosition] = useState({ left: 0, top: 0, width: 240, maxHeight: 320 });
  const trigger = useRef<HTMLButtonElement>(null),
    popover = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    id = useId();
  const items = options.filter(
    (o) => !o.disabled && `${o.label} ${o.value}`.toLowerCase().includes(query.toLowerCase()),
  );
  function close(focus = false) {
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    function place() {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 240), window.innerWidth - 24);
      const below = window.innerHeight - r.bottom - 16;
      const above = r.top - 16;
      const height = Math.max(100, Math.min(320, Math.max(below, above)));
      setPosition({
        left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)),
        top: below >= Math.min(240, above) ? r.bottom + 5 : Math.max(12, r.top - height - 5),
        width,
        maxHeight: height,
      });
    }
    place();
    input.current?.focus();
    function outside(e: PointerEvent) {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !popover.current?.contains(target)) close();
    }
    function scroll(e: Event) {
      if (!popover.current?.contains(e.target as Node)) place();
    }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  useEffect(() => {
    popover.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  function choose(v: string) {
    onChange(v);
    close(true);
  }
  function show() {
    setQuery('');
    setIndex(0);
    setOpen(true);
  }
  return (
    <div className="search-select">
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
        onClick={() => (open ? close() : show())}
      >
        <span>{options.find((o) => o.value === value)?.label || value || 'Default'}</span>
        <span className={open ? 'rotate-down' : 'rotate-right'}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={popover}
                className="select-popover"
                style={{ position: 'fixed', ...position, zIndex: 1100 }}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{
                  duration: document.documentElement.dataset.lowMotion === 'true' ? 0 : 0.12,
                }}
              >
                <input
                  ref={input}
                  role="combobox"
                  aria-label={`Search ${label}`}
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={id}
                  aria-activedescendant={items[index] ? `${id}-${index}` : undefined}
                  placeholder={custom ? 'Search or enter a value…' : 'Search…'}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setIndex(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      close(true);
                    }
                    if (e.key === 'Tab') {
                      close();
                    }
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setIndex(Math.min(index + 1, Math.max(0, items.length - 1)));
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setIndex(Math.max(0, index - 1));
                    }
                    if (e.key === 'Home') {
                      e.preventDefault();
                      setIndex(0);
                    }
                    if (e.key === 'End') {
                      e.preventDefault();
                      setIndex(Math.max(0, items.length - 1));
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (items[index]) choose(items[index].value);
                      else if (custom && query.trim()) choose(query.trim());
                    }
                  }}
                />
                <div role="listbox" id={id} aria-label={label}>
                  {items.map((item, i) => (
                    <button
                      type="button"
                      role="option"
                      id={`${id}-${i}`}
                      tabIndex={-1}
                      aria-selected={item.value === value}
                      data-highlighted={i === index}
                      className={i === index ? 'highlighted' : ''}
                      key={item.value}
                      onPointerMove={() => setIndex(i)}
                      onClick={() => choose(item.value)}
                    >
                      <span>{item.label}</span>
                      {item.detail && <small>{item.detail}</small>}
                    </button>
                  ))}
                  {!items.length && (
                    <p className="muted">
                      {custom ? 'Press Enter to use this value.' : 'No matches.'}
                    </p>
                  )}
                  {custom && query.trim() && !options.some((o) => o.value === query.trim()) && (
                    <button type="button" onClick={() => choose(query.trim())}>
                      Use “{query.trim()}”
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          trigger.current?.closest('dialog') || document.body,
        )}
    </div>
  );
}
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-button"
      title={done ? 'Copied' : 'Copy'}
      aria-label={done ? 'Copied' : 'Copy'}
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          })
          .catch(() => setDone(false))
      }
    >
      <Icon name="copy" size={14} />
      {done && <span>Copied</span>}
    </button>
  );
}
