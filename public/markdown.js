import { Marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { escapeHTML as e } from './escape.js';

const parser = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: (token) => e(token.text),
    image: (token) => `<a href="${e(token.href)}">Image: ${e(token.text || 'attachment')}</a>`,
  },
});
export function markdown(value) {
  const source = String(value ?? '');
  if (!DOMPurify.isSupported) return `<p>${e(source)}</p>`;
  const fragment = DOMPurify.sanitize(parser.parse(source), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'em',
      'del',
      's',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'a',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'input',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'type', 'checked', 'disabled', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll('a')) {
    try {
      const url = new URL(link.getAttribute('href') || '', window.location.href);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Unsupported URL');
      link.setAttribute('rel', 'noopener noreferrer');
      if (url.origin !== window.location.origin) link.setAttribute('target', '_blank');
    } catch {
      link.removeAttribute('href');
    }
  }
  for (const input of fragment.querySelectorAll('input')) {
    input.setAttribute('type', 'checkbox');
    input.setAttribute('disabled', '');
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
export function markdownEditor({ id, name, label, value = '', max = 50000, rows = 8 }) {
  return `<section class="markdown-editor" data-editor="${e(id)}"><label class="field-label" for="${e(id)}">${e(label)}</label><div class="markdown-toolbar"><div role="tablist" aria-label="${e(label)} editor"><button type="button" role="tab" aria-selected="true" aria-controls="${e(id)}-write" data-action="markdown-tab" data-mode="write">Write</button><button type="button" role="tab" aria-selected="false" aria-controls="${e(id)}-preview" data-action="markdown-tab" data-mode="preview">Preview</button></div><div class="markdown-tools" aria-label="Formatting"><button type="button" data-action="markdown-format" data-format="bold" aria-label="Bold">B</button><button type="button" data-action="markdown-format" data-format="italic" aria-label="Italic">I</button><button type="button" data-action="markdown-format" data-format="code" aria-label="Code">&lt;/&gt;</button><button type="button" data-action="markdown-format" data-format="link" aria-label="Insert link">Link</button><button type="button" data-action="markdown-format" data-format="task" aria-label="Task list">Checklist</button></div></div><div id="${e(id)}-write" role="tabpanel"><textarea class="input" id="${e(id)}" name="${e(name)}" rows="${rows}" maxlength="${max}">${e(value)}</textarea></div><div id="${e(id)}-preview" class="prose markdown-preview" role="tabpanel" hidden></div><p class="form-help">Markdown supported: headings, lists, checklists, tables, quotes, links, and fenced code.</p></section>`;
}
export function handleMarkdownAction(element) {
  const editor = element.closest('[data-editor]');
  if (!editor) return false;
  const input = editor.querySelector('textarea');
  if (element.dataset.action === 'markdown-tab') {
    const preview = element.dataset.mode === 'preview';
    editor.querySelector(`#${input.id}-write`).hidden = preview;
    const pane = editor.querySelector('.markdown-preview');
    pane.hidden = !preview;
    if (preview)
      pane.innerHTML = input.value.trim()
        ? markdown(input.value)
        : '<p class="muted">Nothing to preview yet.</p>';
    for (const tab of editor.querySelectorAll('[data-mode]'))
      tab.setAttribute('aria-selected', String(tab.dataset.mode === element.dataset.mode));
    return true;
  }
  if (element.dataset.action === 'markdown-format') {
    editor.querySelector('[data-mode="write"]').click();
    const selected = input.value.slice(input.selectionStart, input.selectionEnd);
    const [before, after, fallback] = {
      bold: ['**', '**', 'bold text'],
      italic: ['_', '_', 'italic text'],
      code: ['`', '`', 'code'],
      link: ['[', '](https://example.com)', 'link text'],
      task: ['- [ ] ', '', 'task'],
    }[element.dataset.format];
    const start = input.selectionStart;
    const text = selected || fallback;
    input.setRangeText(before + text + after, start, input.selectionEnd, 'end');
    input.focus();
    input.setSelectionRange(start + before.length, start + before.length + text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
}
