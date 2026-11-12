import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icons';
import { useAnchoredPopover, revealOption } from './useAnchoredPopover';
export { Icon, ProviderIcon, ProviderName, RelayMark, providerName } from './Icons';
export type ListOption = { value: string; label: string; detail?: string; icon?: ReactNode };
// Every word typed must appear somewhere in the option, in any order.
export function matchesQuery(text: string, query: string) {
  const haystack = text.toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
// The one list every dropdown shows: Select, the task picker and chat mentions. The field that
// owns it keeps focus and points at the highlighted row with aria-activedescendant.
export function OptionList({
  id,
  label,
  items,
  selected,
  active,
  onActive,
  onChoose,
  empty,
  children,
}: {
  id: string;
  label: string;
  items: ListOption[];
  selected?: string;
  active: number;
  onActive: (index: number) => void;
  onChoose: (value: string) => void;
  empty: string;
  children?: ReactNode;
}) {
  return (
    <div role="listbox" id={id} aria-label={label}>
      {items.map((item, i) => (
        <button
          type="button"
          role="option"
          id={`${id}-${i}`}
          tabIndex={-1}
          aria-selected={item.value === selected}
          data-highlighted={i === active}
          className={i === active ? 'highlighted' : ''}
          key={item.value}
          onPointerDown={(event) => event.preventDefault()}
          onPointerMove={() => onActive(i)}
          onClick={() => onChoose(item.value)}
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
          {empty}
        </p>
      )}
      {children}
    </div>
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
  options: (ListOption & { disabled?: boolean })[];
  onChange: (value: string) => void;
  custom?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [index, setIndex] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null),
    popover = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    id = useId();
  const items = options.filter(
    (o) => !o.disabled && matchesQuery(`${o.label} ${o.value} ${o.detail || ''}`, query),
  );
  const selected = options.find((option) => option.value === value),
    displayLabel = selected?.label || value || 'Default';
  function close(focus = false) {
    setOpen(false);
    if (focus) trigger.current?.focus({ preventScroll: true });
  }
  useAnchoredPopover(open, trigger, popover, () => close());
  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true });
    function outside(e: PointerEvent) {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !popover.current?.contains(target)) close();
    }
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  useEffect(() => {
    revealOption(
      popover.current?.querySelector('[role="listbox"]') || null,
      popover.current?.querySelector('[data-highlighted="true"]') || null,
    );
  }, [open, index, query]);
  function choose(v: string) {
    onChange(v);
    close(true);
  }
  function show() {
    setQuery('');
    setIndex(
      Math.max(
        0,
        options.filter((o) => !o.disabled).findIndex((o) => o.value === value),
      ),
    );
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
                data-framer-portal-id={id}
                className={
                  custom || options.length > 7 || query
                    ? 'select-popover'
                    : 'select-popover select-short'
                }
                role="region"
                aria-label={`${label} options`}
                style={{
                  position: 'fixed',
                  inset: 'auto',
                  margin: 0,
                  visibility: 'hidden',
                  zIndex: 1100,
                }}
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
                      close(true);
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
                <OptionList
                  id={id}
                  label={label}
                  items={items}
                  selected={value}
                  active={index}
                  onActive={setIndex}
                  onChoose={choose}
                  empty={custom ? 'Press Enter to use this value.' : 'No matches.'}
                >
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
                </OptionList>
              </motion.div>
            )}
          </AnimatePresence>,
          trigger.current?.closest('dialog, [data-popover-container]') || document.body,
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
