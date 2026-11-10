import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icons';
export { Icon, ProviderIcon, ProviderName, RelayMark, providerName } from './Icons';
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
  options: {
    value: string;
    label: string;
    detail?: string;
    disabled?: boolean;
    icon?: ReactNode;
  }[];
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
  const selected = options.find((option) => option.value === value),
    displayLabel = selected?.label || value || 'Default';
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
        aria-label={`${label}: ${displayLabel}`}
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
        <span className="select-value">
          {selected?.icon}
          {displayLabel}
        </span>
        <span className={`select-caret ${open ? 'is-open' : ''}`}>
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
                role="region"
                aria-label={`${label} options`}
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
                      <span className="select-option-label">
                        {item.icon}
                        {item.label}
                      </span>
                      {item.detail && <small>{item.detail}</small>}
                    </button>
                  ))}
                  {!items.length && (
                    <p className="muted" role="option" aria-disabled="true">
                      {custom ? 'Press Enter to use this value.' : 'No matches.'}
                    </p>
                  )}
                  {custom && query.trim() && !options.some((o) => o.value === query.trim()) && (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      onClick={() => choose(query.trim())}
                    >
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
      type="button"
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
