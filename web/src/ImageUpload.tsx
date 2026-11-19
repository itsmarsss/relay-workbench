import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useSession, Notice } from './Session';
import { Icon } from './Icons';

const accepted = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

// Images attached to a Markdown field: pick them, paste them (screenshots included) or drop them
// anywhere on the composer. Each upload becomes a Markdown image in the text.
export function useImageUpload(insert: (text: string) => void) {
  const { bootstrap } = useSession(),
    input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null),
    [error, setError] = useState(''),
    [dragging, setDragging] = useState(false);
  const active = useRef(false),
    // dragenter and dragleave fire for every child the pointer crosses; count them.
    depth = useRef(0);
  const busy = progress !== null;
  async function upload(files: File[]) {
    if (active.current || !bootstrap || !files.length) return;
    const images = files.filter((file) => accepted.includes(file.type));
    if (!images.length) {
      setError('Only PNG, JPEG, GIF or WebP images can be attached.');
      return;
    }
    active.current = true;
    setError('');
    setProgress({ done: 0, total: images.length });
    try {
      if (images.length > 20) throw new Error('Attach at most 20 images at once.');
      const large = images.find((file) => file.size > 10 * 1024 * 1024);
      if (large) throw new Error(`${large.name || 'That image'} is over 10 MB.`);
      for (const [index, file] of images.entries()) {
        const response = await fetch('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-Relay-Token': bootstrap.token },
          body: file,
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Image upload failed');
        const name = (file.name && file.name !== 'image.png' ? file.name : 'Pasted image').replace(
          /[\[\]\\\r\n]/g,
          '_',
        );
        insert(`\n![${name}](${value.url})\n`);
        setProgress({ done: index + 1, total: images.length });
      }
      if (images.length < files.length) setError('Skipped files that are not images.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Image upload failed');
    } finally {
      active.current = false;
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }
  // Clipboard screenshots arrive as items, not always as files.
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length) {
      event.preventDefault();
      void upload(files);
    }
  };
  // Spread on the whole composer: dropping anywhere on it attaches, and it shows it will.
  const zone = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current = 0;
      setDragging(false);
      void upload(Array.from(event.dataTransfer.files));
    },
    'data-image-drop': dragging ? 'over' : 'ready',
  };
  return {
    onPaste,
    zone,
    dragging,
    busy,
    control: (
      <div className="image-upload-control">
        <input
          ref={input}
          type="file"
          accept={accepted.join(',')}
          multiple
          hidden
          aria-label="Attach images"
          onChange={(event) => void upload(Array.from(event.target.files || []))}
        />
        <button
          type="button"
          className="attach-image"
          disabled={busy || !bootstrap}
          title="Attach images. You can also paste or drop them here."
          onClick={() => input.current?.click()}
        >
          <Icon name={busy ? 'clock' : 'image'} size={15} />
          <span>
            {progress
              ? progress.total > 1
                ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
                : 'Uploading…'
              : 'Add image'}
          </span>
        </button>
        {error && <Notice>{error}</Notice>}
      </div>
    ),
  };
}

// A file dropped outside a composer would make the browser open it and leave Relay. Ignore it.
export function ignoreStrayFileDrops() {
  const stray = (event: globalThis.DragEvent) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'))
      event.preventDefault();
  };
  window.addEventListener('dragover', stray);
  window.addEventListener('drop', stray);
  return () => {
    window.removeEventListener('dragover', stray);
    window.removeEventListener('drop', stray);
  };
}
