import { useState } from 'react';
import { Markdown } from './Markdown';
import { optionLead, tradeoffPoints } from './task-data';

type Option = { id: string; title: string; description: string; tradeoffs: string };

// A long agent summary shows its opening lines; the rest opens on request.
export function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320;
  return (
    <div className="clamped-text">
      <p className={long && !open ? 'clamped' : ''}>{text}</p>
      {long && (
        <button
          type="button"
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

// One layout for every choice an agent hands back. The idea, the reason it is recommended and the
// tradeoffs stay in view; the steps open on request. The recommended option leads.
export function DecisionOptions({
  name,
  options,
  selected,
  onSelect,
  recommendedId = '',
  reason = '',
}: {
  name: string;
  options: Option[];
  selected: string;
  onSelect?: (id: string) => void;
  recommendedId?: string;
  reason?: string;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const ordered = [...options].sort(
    (a, b) => Number(b.id === recommendedId) - Number(a.id === recommendedId),
  );
  return (
    <div className="plan-options">
      {ordered.map((option) => {
        const { lead, rest } = optionLead(option.description);
        const points = tradeoffPoints(option.tradeoffs);
        const more = !!rest || lead.length > 360;
        const shown = !!open[option.id];
        return (
          <article
            key={option.id}
            className={
              onSelect ? (selected === option.id ? 'selectable selected' : 'selectable') : ''
            }
            onClick={() => onSelect?.(option.id)}
          >
            <h3>
              {onSelect && (
                <input
                  type="radio"
                  name={name}
                  aria-label={`Select ${option.title}`}
                  checked={selected === option.id}
                  onChange={() => onSelect(option.id)}
                />
              )}
              <span>{option.title}</span>
              {option.id === recommendedId && <small>Recommended</small>}
            </h3>
            {(lead || shown) && (
              <div className={shown ? 'option-lead' : 'option-lead clamped'}>
                <Markdown text={shown ? option.description : lead} />
              </div>
            )}
            {more && (
              <button
                type="button"
                className="text-button"
                aria-expanded={shown}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen({ ...open, [option.id]: !shown });
                }}
              >
                {shown ? 'Hide details' : 'Show details'}
              </button>
            )}
            {option.id === recommendedId && reason && (
              <div className="option-note">
                <h4>Why this one</h4>
                <Markdown text={reason} />
              </div>
            )}
            <div className="option-note">
              <h4>Tradeoffs</h4>
              {points ? (
                <ul className="tradeoff-points">
                  {points.map((point, index) => (
                    <li key={index} className={point.kind}>
                      <span>{point.kind === 'pro' ? 'Pro' : 'Con'}</span>
                      <Markdown text={point.text} />
                    </li>
                  ))}
                </ul>
              ) : (
                <Markdown text={option.tradeoffs} />
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
