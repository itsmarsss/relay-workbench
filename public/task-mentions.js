import { escapeHTML as e } from './escape.js';
export function mentionPresent(question, label) {
  const needle = '@' + label;
  let start = question.indexOf(needle);
  while (start !== -1) {
    const before = question[start - 1],
      after = question[start + needle.length];
    if ((!before || !/[\p{L}\p{N}_@]/u.test(before)) && (!after || !/[\p{L}\p{N}_]/u.test(after)))
      return true;
    start = question.indexOf(needle, start + 1);
  }
  return false;
}
export function activeMentions(question, mentions = []) {
  return mentions.filter(
    (m) => m && typeof m.label === 'string' && mentionPresent(question, m.label),
  );
}
export function mentionQuestion(question, mentions = []) {
  const candidates = activeMentions(question, mentions).sort(
    (a, b) => b.label.length - a.label.length,
  );
  let output = '',
    cursor = 0;
  while (cursor < question.length) {
    let found = null;
    for (const m of candidates) {
      let index = question.indexOf('@' + m.label, cursor);
      while (index !== -1) {
        const before = question[index - 1],
          after = question[index + m.label.length + 1];
        if (
          (!before || !/[\p{L}\p{N}_@]/u.test(before)) &&
          (!after || !/[\p{L}\p{N}_]/u.test(after))
        ) {
          if (!found || index < found.index) found = { ...m, index };
          break;
        }
        index = question.indexOf('@' + m.label, index + 1);
      }
    }
    if (!found) {
      output += e(question.slice(cursor));
      break;
    }
    output += e(question.slice(cursor, found.index));
    output += /^[a-f0-9-]{36}$/.test(found.id)
      ? `<a class="task-mention" title="${e(found.label)}" href="#task/${e(found.id)}/overview">@${e(found.label)}</a>`
      : e('@' + found.label);
    cursor = found.index + found.label.length + 1;
  }
  return output;
}

export function withoutMention(question, label) {
  const needle = '@' + label;
  let cursor = 0,
    output = '',
    index = question.indexOf(needle);
  while (index !== -1) {
    const before = question[index - 1],
      after = question[index + needle.length];
    const valid =
      (!before || !/[\p{L}\p{N}_@]/u.test(before)) && (!after || !/[\p{L}\p{N}_]/u.test(after));
    output += question.slice(cursor, index) + (valid ? '' : needle);
    cursor = index + needle.length;
    index = question.indexOf(needle, cursor);
  }
  return output + question.slice(cursor);
}

// Link plain task references in prose while preserving code and existing Markdown links.
export function mentionAnswerHTML(html, mentions = []) {
  if (typeof document === 'undefined') return html;
  const root = document.createElement('div');
  root.innerHTML = html;
  const unique = new Map();
  for (const m of mentions)
    if (m && typeof m.label === 'string' && /^[a-f0-9-]{36}$/.test(m.id)) {
      if (!unique.has(m.label)) unique.set(m.label, m);
      else if (unique.get(m.label)?.id !== m.id) unique.set(m.label, null);
    }
  const candidates = [...unique.values()].filter(Boolean);
  const walker = document.createTreeWalker(root, 4),
    nodes = [];
  while (walker.nextNode())
    if (!walker.currentNode.parentElement.closest('a,pre,code,button'))
      nodes.push(walker.currentNode);
  for (const node of nodes)
    if (activeMentions(node.textContent, candidates).length) {
      const replacement = document.createElement('span');
      replacement.innerHTML = mentionQuestion(node.textContent, candidates);
      node.replaceWith(...replacement.childNodes);
    }
  return root.innerHTML;
}
