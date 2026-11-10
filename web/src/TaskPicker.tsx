import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover, revealOption } from './useAnchoredPopover';
import type { Task } from './types';
export function matchTasks(tasks: Task[], query: string): Task[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((task) =>
    words.every((word) =>
      `${task.title} ${task.repository?.name || ''} ${task.id}`.toLocaleLowerCase().includes(word),
    ),
  );
}
export function TaskPicker({
  id,
  label = 'Task for pane',
  tasks,
  selected,
  onChange,
}: {
  id: string;
  label?: string;
  tasks: Task[];
  selected: string;
  onChange: (value: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    popover = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const task = tasks.find((item) => item.id === selected),
    filtered = matchTasks(tasks, query);
  const inputID = `picker-${id}`,
    listID = `picker-list-${id}`;
  useAnchoredPopover(open, input, popover, () => setOpen(false), { maxHeight: 280, gap: 5 });
  useEffect(() => {
    if (open)
      revealOption(document.getElementById(listID), document.getElementById(`${listID}-${active}`));
  }, [open, active, listID, query]);
  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (
        !root.current?.contains(event.target as globalThis.Node) &&
        !popover.current?.contains(event.target as globalThis.Node)
      ) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  function choose(value: string) {
    onChange(value);
    setOpen(false);
    setQuery('');
    input.current?.focus({ preventScroll: true });
  }
  return (
    <div className="picker" ref={root}>
      <label className="sr-only" htmlFor={inputID}>
        {label}
      </label>
      <input
        ref={input}
        id={inputID}
        type="search"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listID}
        aria-activedescendant={open && filtered[active] ? `${listID}-${active}` : undefined}
        value={open ? query : task?.title || (selected ? 'Task unavailable' : '')}
        placeholder="Choose a task…"
        onFocus={() => {
          setOpen(true);
          setQuery('');
          setActive(0);
        }}
        onClick={() => {
          if (!open) {
            setOpen(true);
            setQuery('');
            setActive(0);
          }
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            setOpen(false);
            setQuery('');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setQuery('');
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive((current) =>
              Math.max(
                0,
                Math.min(filtered.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)),
              ),
            );
          } else if (event.key === 'Enter' && open && filtered[active]) {
            event.preventDefault();
            choose(filtered[active].id);
          }
        }}
      />
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="picker-popover"
            role="region"
            aria-label={`${label} options`}
            ref={popover}
            style={{ position: 'fixed', inset: 'auto', visibility: 'hidden', zIndex: 1100 }}
          >
            <ul role="listbox" id={listID} aria-label="Tasks">
              {filtered.map((item, index) => (
                <li
                  role="option"
                  id={`${listID}-${index}`}
                  aria-selected={selected === item.id}
                  key={item.id}
                  className={index === active ? 'picker-active' : ''}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(item.id)}
                >
                  <strong>{item.title}</strong>
                  <small>{item.repository?.name || 'Unspecified'}</small>
                </li>
              ))}
              {filtered.length === 0 && (
                <li role="option" aria-disabled="true">
                  No matching tasks
                </li>
              )}
            </ul>
            {selected && (
              <button
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose('')}
              >
                Clear task
              </button>
            )}
          </div>,
          input.current?.closest('dialog') || document.body,
        )}
    </div>
  );
}
