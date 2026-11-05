// Shared parsing keeps browser anchors identical to server validation.
function filename(header) {
  const value = header.slice(4);
  let path = value;
  if (value.startsWith('"')) {
    try {
      path = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}
export function diffLines(diff) {
  let oldPath = null,
    newPath = null,
    oldLine = 0,
    newLine = 0,
    inHunk = false;
  const lines = [];
  for (const text of (diff.text || '').split('\n')) {
    let anchor = null;
    if (text.startsWith('diff --git ')) {
      inHunk = false;
      oldPath = null;
      newPath = null;
    }
    if (!inHunk && text.startsWith('--- ')) oldPath = filename(text);
    if (!inHunk && text.startsWith('+++ ')) newPath = filename(text);
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && /^[ +\-]/.test(text)) {
      const deletion = text.startsWith('-');
      anchor = {
        path: deletion ? oldPath : newPath,
        side: deletion ? 'old' : 'new',
        line: deletion ? oldLine : newLine,
        content: text.slice(1),
      };
      if (!text.startsWith('+')) oldLine++;
      if (!deletion) newLine++;
      if (!anchor.path) anchor = null;
    }
    lines.push({
      text,
      anchor,
      kind:
        text.startsWith('+') && !text.startsWith('+++')
          ? 'addition'
          : text.startsWith('-') && !text.startsWith('---')
            ? 'deletion'
            : hunk
              ? 'hunk'
              : '',
    });
  }
  for (const file of diff.untracked || []) {
    lines.push({ text: `New file: ${file.name}`, kind: 'hunk', anchor: null });
    const inspectOnly =
      file.content.startsWith('[Binary file;') || file.content.startsWith('[File over 200 KB');
    file.content.split('\n').forEach((content, index) =>
      lines.push({
        text: '+' + content,
        kind: 'addition',
        anchor: inspectOnly ? null : { path: file.name, side: 'new', line: index + 1, content },
      }),
    );
  }
  return lines;
}
