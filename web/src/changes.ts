export type ChangePart = { kind: 'same' | 'removed' | 'added'; text: string };
export function textChanges(before: string, after: string): ChangePart[] {
  if (before === after) return [{ kind: 'same', text: after }];
  const a = before.match(/\s+|[^\s]+/g) || [],
    b = after.match(/\s+|[^\s]+/g) || [];
  if (a.length * b.length > 300000 || a.length > 1000 || b.length > 1000)
    return [
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ];
  const width = b.length + 1,
    scores = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      scores[i * width + j] =
        a[i] === b[j]
          ? scores[(i + 1) * width + j + 1]! + 1
          : Math.max(scores[(i + 1) * width + j]!, scores[i * width + j + 1]!);
  const parts: ChangePart[] = [];
  const add = (kind: ChangePart['kind'], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      add('same', a[i++]!);
      j++;
    } else if (
      i < a.length &&
      (j === b.length || scores[(i + 1) * width + j]! >= scores[i * width + j + 1]!)
    )
      add('removed', a[i++]!);
    else add('added', b[j++]!);
  }
  return parts;
}
export type FieldChange = { path: string; before: string; after: string };
export function fieldChanges(before: unknown, after: unknown): FieldChange[] {
  const result: FieldChange[] = [];
  const format = (value: unknown) =>
    value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  function visit(a: unknown, b: unknown, path: string, depth: number) {
    if (result.length >= 300 || JSON.stringify(a) === JSON.stringify(b)) return;
    if (
      depth < 12 &&
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const old = a as Record<string, unknown>,
        next = b as Record<string, unknown>;
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (['taskRevision', 'configRevision', 'policyRevision'].includes(key)) continue;
        visit(old[key], next[key], path ? `${path}.${key}` : key, depth + 1);
      }
    } else result.push({ path: path || 'Value', before: format(a), after: format(b) });
  }
  visit(before, after, '', 0);
  return result;
}
