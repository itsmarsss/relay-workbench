export type DiffLine = {
  text: string;
  kind: 'addition' | 'deletion' | 'hunk' | 'context' | 'meta';
  old: number | null;
  next: number | null;
};
export type DiffFile = { path: string; oldPath: string; lines: DiffLine[] };
// Git quotes paths with C escapes and octal UTF-8 bytes, not JSON escapes.
function pathName(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes: number[] = [],
      encoder = new TextEncoder();
    const escapes: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      a: '\x07',
      '\\': '\\',
      '"': '"',
    };
    for (let i = 1; i < value.length - 1; i++) {
      if (value[i] === '\\') {
        const octal = value.slice(i + 1).match(/^[0-7]{1,3}/);
        if (octal) {
          bytes.push(parseInt(octal[0], 8));
          i += octal[0].length;
        } else {
          i++;
          bytes.push(...encoder.encode(escapes[value[i]!] ?? value[i]!));
        }
      } else {
        const point = String.fromCodePoint(value.codePointAt(i)!);
        bytes.push(...encoder.encode(point));
        i += point.length - 1;
      }
    }
    value = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return value.replace(/^[ab]\//, '');
}
function headerPaths(value: string): string[] {
  const quoted = value.match(/"(?:[^"\\]|\\.)*"|[^ ]+/g) ?? [];
  if (quoted.length === 2) return quoted.map(pathName);
  // Git does not quote spaces; the b/ marker separates ordinary path pairs.
  const separator = value.indexOf(' b/');
  return separator >= 0
    ? [pathName(value.slice(0, separator)), pathName(value.slice(separator + 1))]
    : [];
}
export function splitDiff(text: string, limit = 40000): DiffFile[] {
  if (!text.trim()) return [];
  const files: DiffFile[] = [];
  let file: DiffFile | undefined,
    old = 0,
    next = 0,
    inHunk = false;
  for (const textLine of text.split('\n').slice(0, limit)) {
    if (textLine.startsWith('diff --git ')) {
      const paths = headerPaths(textLine.slice(11));
      file = { path: paths[1] || '', oldPath: paths[0] || '', lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) {
      file = { path: 'Changes', oldPath: '', lines: [] };
      files.push(file);
    }
    if (textLine.startsWith('rename to ') && !inHunk) file.path = pathName(textLine.slice(10));
    if (textLine.startsWith('rename from ') && !inHunk) file.oldPath = pathName(textLine.slice(12));
    if (textLine.startsWith('--- ') && !inHunk) {
      file.oldPath = pathName(textLine.slice(4));
      if (!file.path) file.path = file.oldPath;
      continue;
    }
    if (textLine.startsWith('+++ ') && !inHunk) {
      const path = pathName(textLine.slice(4));
      if (path !== '/dev/null') file.path = path;
      continue;
    }
    const hunk = textLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ text: textLine, kind: 'hunk', old: null, next: null });
      continue;
    }
    const kind = inHunk
      ? textLine.startsWith('+')
        ? 'addition'
        : textLine.startsWith('-')
          ? 'deletion'
          : textLine.startsWith(' ')
            ? 'context'
            : 'meta'
      : 'meta';
    file.lines.push({
      text: textLine,
      kind,
      old: kind === 'deletion' || kind === 'context' ? old++ : null,
      next: kind === 'addition' || kind === 'context' ? next++ : null,
    });
  }
  return files
    .filter((file) => file.path || file.lines.some((line) => line.text))
    .map((file) => ({ ...file, path: file.path || file.oldPath || 'Binary or renamed file' }));
}
