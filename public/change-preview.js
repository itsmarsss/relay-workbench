import { escapeHTML as e } from './escape.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const formatted = (value) => (value === undefined ? '(not set)' : JSON.stringify(value, null, 2));

// Compare JSON fields structurally; arrays remain atomic and ordered.
export function changedFields(before, after, path = []) {
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      changedFields(
        Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(after, key) ? after[key] : undefined,
        [...path, key],
      ),
    );
  }
  if (formatted(before) === formatted(after)) return [];
  return [{ path, before, after }];
}

export function changePreview(before, after) {
  const fields = changedFields(before, after);
  if (!fields.length) return '<p class="form-help">No setting values change.</p>';
  return `<div class="change-preview" aria-label="Proposed changes">${fields
    .map(
      (field) =>
        `<section class="change-field">${field.path.length ? `<h4>${e(field.path.join(' → '))}</h4>` : ''}<div class="change-value change-removed"><span class="change-marker" aria-hidden="true">−</span><span class="sr-only">Current: </span><pre>${e(formatted(field.before))}</pre></div><div class="change-value change-added"><span class="change-marker" aria-hidden="true">+</span><span class="sr-only">Proposed: </span><pre>${e(formatted(field.after))}</pre></div></section>`,
    )
    .join('')}</div>`;
}
