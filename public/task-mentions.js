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
      ? `<a class="task-mention" href="#task/${e(found.id)}/overview">@${e(found.label)}</a>`
      : e('@' + found.label);
    cursor = found.index + found.label.length + 1;
  }
  return output;
}
