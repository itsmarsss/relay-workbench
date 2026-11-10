import { useId, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { Icon } from './UI';
import type { useImageUpload } from './ImageUpload';

export function MarkdownEditor({
  value,
  onChange,
  uploads,
  label = 'Description',
}: {
  value: string;
  onChange: (value: string) => void;
  uploads: ReturnType<typeof useImageUpload>;
  label?: string;
}) {
  const id = useId(),
    textarea = useRef<HTMLTextAreaElement>(null),
    [preview, setPreview] = useState(false),
    [error, setError] = useState('');
  function format(kind: 'bold' | 'italic' | 'code' | 'link' | 'checklist') {
    const element = textarea.current;
    if (!element) return;
    const start = element.selectionStart,
      end = element.selectionEnd,
      selected = value.slice(start, end);
    let replacement: string;
    switch (kind) {
      case 'bold':
        replacement = `**${selected || 'bold text'}**`;
        break;
      case 'italic':
        replacement = `*${selected || 'italic text'}*`;
        break;
      case 'code':
        replacement = selected.includes('\n')
          ? `\n\`\`\`\n${selected}\n\`\`\`\n`
          : `\`${selected || 'code'}\``;
        break;
      case 'link':
        replacement = `[${selected || 'label'}](https://)`;
        break;
      case 'checklist':
        replacement = (selected || 'Item')
          .split('\n')
          .map((line) => `- [ ] ${line}`)
          .join('\n');
        break;
    }
    const next = value.slice(0, start) + replacement + value.slice(end);
    if (next.length > 50000) {
      setError('Description is limited to 50,000 characters.');
      return;
    }
    setError('');
    onChange(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + replacement.length, start + replacement.length);
    });
  }
  return (
    <div className="field markdown-field">
      <label htmlFor={id}>{label}</label>
      <div className="markdown-editor">
        <div className="markdown-toolbar">
          <div className="markdown-mode" role="group" aria-label={`${label} editor`}>
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
          <div className="markdown-tools" role="group" aria-label="Format Markdown">
            <button
              type="button"
              title="Bold"
              aria-label="Bold"
              disabled={preview}
              onClick={() => format('bold')}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              title="Italic"
              aria-label="Italic"
              disabled={preview}
              onClick={() => format('italic')}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              title="Code"
              aria-label="Code"
              disabled={preview}
              onClick={() => format('code')}
            >
              <Icon name="code" size={17} />
            </button>
            <button type="button" disabled={preview} onClick={() => format('link')}>
              Link
            </button>
            <button type="button" disabled={preview} onClick={() => format('checklist')}>
              Checklist
            </button>
          </div>
        </div>
        {preview ? (
          <div className="markdown-preview">
            <Markdown text={value || 'Nothing to preview yet.'} />
          </div>
        ) : (
          <textarea
            ref={textarea}
            id={id}
            aria-label={label}
            onPaste={uploads.onPaste}
            onDrop={uploads.onDrop}
            onDragOver={uploads.onDragOver}
            rows={7}
            maxLength={50000}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Requirements, context, and links. Markdown is supported."
          />
        )}
        <div className="markdown-attachments">
          {uploads.control}
          <span>Paste or drop images · 10 MB each</span>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
