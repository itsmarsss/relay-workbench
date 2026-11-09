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

// Bound comparison work for large descriptions; shared edges still retain context.
export function diffSequence(before, after) {
  let start = 0,
    end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const a = before.slice(start, before.length - end),
    b = after.slice(start, after.length - end);
  const rows = before.slice(0, start).map((text) => ({ kind: 'context', text }));
  if (a.length * b.length <= 250000) {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i * width + j] =
          a[i] === b[j]
            ? 1 + table[(i + 1) * width + j + 1]
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        rows.push({ kind: 'context', text: a[i++] });
        j++;
      } else if (
        i < a.length &&
        (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])
      )
        rows.push({ kind: 'removed', text: a[i++] });
      else rows.push({ kind: 'added', text: b[j++] });
    }
  } else {
    rows.push(
      ...a.map((text) => ({ kind: 'removed', text })),
      ...b.map((text) => ({ kind: 'added', text })),
    );
  }
  rows.push(...before.slice(before.length - end).map((text) => ({ kind: 'context', text })));
  return rows;
}

function paragraphDiff(before, after) {
  const rows = diffSequence(before.split('\n'), after.split('\n'));
  // Pair consecutive replaced lines for word-level emphasis, preserving line order.
  const highlights = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'removed') continue;
    let middle = i,
      end = i;
    while (middle < rows.length && rows[middle].kind === 'removed') middle++;
    end = middle;
    while (end < rows.length && rows[end].kind === 'added') end++;
    for (let k = 0; k < Math.min(middle - i, end - middle); k++) {
      const tokens = diffSequence(
        rows[i + k].text.match(/\s+|[^\s]+/g) || [],
        rows[middle + k].text.match(/\s+|[^\s]+/g) || [],
      );
      for (const [index, kind] of [
        [i + k, 'removed'],
        [middle + k, 'added'],
      ])
        highlights.set(
          index,
          tokens
            .filter((token) => token.kind === 'context' || token.kind === kind)
            .map((token) =>
              token.kind === 'context' ? e(token.text) : `<mark>${e(token.text)}</mark>`,
            )
            .join(''),
        );
    }
    i = end - 1;
  }
  let oldLine = 0,
    newLine = 0;
  return `<div class="paragraph-diff" aria-label="Text diff"><div class="diff-legend">− Removed · + Added</div>${rows
    .map((row, index) => {
      const oldNumber = row.kind === 'added' ? '' : ++oldLine;
      const newNumber = row.kind === 'removed' ? '' : ++newLine;
      return `<div class="paragraph-diff-line change-${row.kind}"><span class="diff-line-number" aria-hidden="true">${oldNumber}</span><span class="diff-line-number" aria-hidden="true">${newNumber}</span><span class="change-marker" aria-hidden="true">${row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ' '}</span><span class="sr-only">${row.kind === 'removed' ? 'Current: ' : row.kind === 'added' ? 'Proposed: ' : 'Unchanged: '}</span><pre>${highlights.get(index) ?? e(row.text)}</pre></div>`;
    })
    .join('')}</div>`;
}

export function changePreview(before, after) {
  const fields = changedFields(before, after);
  if (!fields.length) return '<p class="form-help">No setting values change.</p>';
  return `<div class="change-preview" aria-label="Proposed changes">${fields
    .map(
      (field) =>
        `<section class="change-field">${field.path.length ? `<h4>${e(field.path.join(' → '))}</h4>` : ''}${typeof field.before === 'string' && typeof field.after === 'string' ? paragraphDiff(field.before, field.after) : `<div class="change-value change-removed"><span class="change-marker" aria-hidden="true">−</span><span class="sr-only">Current: </span><pre>${e(formatted(field.before))}</pre></div><div class="change-value change-added"><span class="change-marker" aria-hidden="true">+</span><span class="sr-only">Proposed: </span><pre>${e(formatted(field.after))}</pre></div>`}</section>`,
    )
    .join('')}</div>`;
}
