import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
function e(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>\"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[char]!,
  );
}

function imageSource(value: string | null): string | null {
  try {
    const url = new URL(value || '', window.location.href);
    if (url.username || url.password) return null;
    if (url.origin === window.location.origin)
      return /^\/api\/attachments\/[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(url.pathname) &&
        !url.search
        ? url.href
        : null;
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
function imageMarkup(href: string | null, alt: string | null, title: string | null) {
  const source = imageSource(href);
  return source
    ? `<img class="markdown-image" src="${e(source)}" alt="${e(alt || 'Image')}"${title ? ` title="${e(title)}"` : ''}>`
    : null;
}
function rawHtml(token: Tokens.HTML | Tokens.Tag) {
  // GitHub issue uploads can use a single HTML img tag. Other HTML stays literal.
  if (DOMPurify.isSupported && /^\s*<img\b[^>]*>\s*$/i.test(token.text)) {
    const fragment = DOMPurify.sanitize(token.text, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['img'],
      ALLOWED_ATTR: ['src', 'alt', 'title'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
    const image = fragment.querySelector('img');
    if (image) {
      const rendered = imageMarkup(image.getAttribute('src'), image.alt, image.title);
      if (rendered) return rendered;
    }
  }
  return e(token.text);
}
const parser = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: rawHtml,
    image: (token) =>
      imageMarkup(token.href, token.text, token.title) ?? e(token.text || 'Image unavailable'),
  },
});
export function markdown(value: unknown): string {
  const source = String(value ?? '');
  if (!DOMPurify.isSupported) return `<p>${e(source)}</p>`;
  const fragment = DOMPurify.sanitize(parser.parse(source, { async: false }), {
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
      'img',
    ],
    ALLOWED_ATTR: [
      'href',
      'title',
      'class',
      'type',
      'checked',
      'disabled',
      'start',
      'align',
      'src',
      'alt',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll('a')) {
    try {
      const url = new URL(link.getAttribute('href') || '', window.location.href);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Unsupported URL');
      if (
        /^#task\/[a-f0-9-]{36}\/(overview|thread|diff|handoffs)$/.test(
          link.getAttribute('href') || '',
        )
      )
        link.classList.add('task-mention');
      link.setAttribute('rel', 'noopener noreferrer');
      if (url.origin !== window.location.origin) link.setAttribute('target', '_blank');
    } catch {
      link.removeAttribute('href');
    }
  }
  for (const image of fragment.querySelectorAll('img')) {
    const source = imageSource(image.getAttribute('src'));
    if (!source) {
      image.replaceWith(document.createTextNode(image.alt || 'Image unavailable'));
      continue;
    }
    image.src = source;
    image.className = 'markdown-image';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    if (!image.closest('a')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'markdown-image-button';
      button.dataset.action = 'view-image';
      button.setAttribute('aria-label', `Enlarge image: ${image.alt}`);
      image.replaceWith(button);
      button.append(image);
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
