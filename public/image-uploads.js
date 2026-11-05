import { escapeHTML as e } from './escape.js';
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const active = new WeakSet();
const safeAlt = (name) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[\[\]\\<>\r\n]/g, ' ')
    .trim()
    .slice(0, 180) || 'Screenshot';

export function installImageUploads({ getToken, onError }) {
  async function upload(editor, files) {
    if (!files.length) return;
    if (active.has(editor)) return onError('Wait for the current images to finish uploading.');
    if (files.length > 10) return onError('Attach at most 10 images at a time.');
    for (const file of files) {
      if (!TYPES.has(file.type)) return onError('Use PNG, JPEG, GIF, or WebP images.');
      if (!file.size || file.size > MAX_BYTES)
        return onError('Images must be between 1 byte and 10 MB.');
    }
    const input = editor.querySelector('textarea');
    const status = editor.querySelector('[data-upload-status]');
    const markers = files.map((file) => ({
      file,
      marker: `![Uploading ${safeAlt(file.name)}…](relay-upload:${crypto.randomUUID()})`,
    }));
    const snippet = '\n\n' + markers.map((item) => item.marker).join('\n\n') + '\n\n';
    if (
      input.value.length - (input.selectionEnd - input.selectionStart) + snippet.length >
      input.maxLength
    )
      return onError('The editor is full. Remove some text before attaching images.');
    active.add(editor);
    editor.dataset.uploading = 'true';
    input.setRangeText(snippet, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const replaceMarker = (marker, value) => {
      const at = input.value.indexOf(marker);
      if (at >= 0) input.setRangeText(value, at, at + marker.length, 'preserve');
    };
    const updatePreview = () => {
      const tab = editor.querySelector('[data-mode="preview"]');
      if (tab?.getAttribute('aria-selected') === 'true') tab.click();
    };
    updatePreview();
    let completed = 0;
    try {
      for (const { file, marker } of markers) {
        status.textContent = `Uploading image ${completed + 1} of ${files.length}…`;
        const response = await fetch('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-Relay-Token': getToken() },
          body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Image upload failed.');
        const replacement = `![${safeAlt(file.name)}](${result.url})`;
        if (input.value.length - marker.length + replacement.length > input.maxLength)
          throw new Error('The editor is full. Remove some text before attaching images.');
        // A user may delete the placeholder while uploading. Respect that edit.
        replaceMarker(marker, replacement);
        completed++;
        updatePreview();
      }
      status.textContent = `${completed} ${completed === 1 ? 'image' : 'images'} attached.`;
    } catch (error) {
      for (const { marker } of markers) replaceMarker(marker, '');
      status.textContent = 'Upload failed. Previously attached images are retained.';
      onError(error.message);
    } finally {
      active.delete(editor);
      delete editor.dataset.uploading;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      updatePreview();
      document.dispatchEvent(new Event('relay-images-updated'));
    }
  }
  document.addEventListener('change', (event) => {
    if (!event.target.matches('[data-image-upload]')) return;
    const files = [...event.target.files];
    event.target.value = '';
    upload(event.target.closest('[data-editor]'), files);
  });
  document.addEventListener('paste', (event) => {
    const editor = event.target.closest('[data-editor]');
    const files = [...(event.clipboardData?.files ?? [])];
    if (!editor || !files.length) return;
    event.preventDefault();
    upload(editor, files);
  });
  document.addEventListener('dragover', (event) => {
    const editor = event.target.closest('[data-editor]');
    if (!editor || ![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    editor.classList.add('image-drop-target');
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    const editor = event.target.closest('[data-editor]');
    if (editor && !editor.contains(event.relatedTarget))
      editor.classList.remove('image-drop-target');
  });
  document.addEventListener('drop', (event) => {
    const editor = event.target.closest('[data-editor]');
    if (!editor || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    editor.classList.remove('image-drop-target');
    upload(editor, [...event.dataTransfer.files]);
  });
}

export function openImageViewer(image) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal wide image-viewer';
  dialog.setAttribute('aria-label', 'Image preview');
  dialog.innerHTML = `<div class="modal-heading"><h2>Image preview</h2><button type="button" class="btn secondary small" data-image-close>Close</button></div><div class="image-lightbox"><img src="${e(image.src)}" alt="${e(image.alt)}" referrerpolicy="no-referrer"><p>${e(image.alt)}</p><p data-image-error hidden>This image could not be loaded. Try opening the original link to check access.</p><a class="btn secondary small" href="${e(image.src)}" target="_blank" rel="noopener noreferrer">Open original</a></div>`;
  dialog.querySelector('[data-image-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('img').addEventListener('error', () => {
    dialog.querySelector('[data-image-error]').hidden = false;
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
