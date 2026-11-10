import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useSession, Notice } from './Session';

export function useImageUpload(insert: (text: string) => void) {
  const { bootstrap } = useSession(),
    input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = useRef(false);
  async function upload(files: File[]) {
    if (active.current || !bootstrap || !files.length) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      if (files.length > 20) throw new Error('Attach at most 20 images at once.');
      for (const file of files) {
        if (
          !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) ||
          file.size > 10 * 1024 * 1024
        )
          throw new Error('Use PNG, JPEG, GIF or WebP images up to 10 MB.');
        const response = await fetch('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-Relay-Token': bootstrap.token },
          body: file,
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Image upload failed');
        insert(`\n![${(file.name || 'Image').replace(/[\[\]\\\r\n]/g, '_')}](${value.url})\n`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Image upload failed');
    } finally {
      active.current = false;
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length) {
      event.preventDefault();
      void upload(files);
    }
  };
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      event.preventDefault();
      void upload(files);
    }
  };
  return {
    onPaste,
    onDrop,
    onDragOver: (event: DragEvent<HTMLTextAreaElement>) => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault();
    },
    busy,
    control: (
      <div className="image-upload-control">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          aria-label="Attach images"
          onChange={(event) => void upload(Array.from(event.target.files || []))}
        />
        <button type="button" disabled={busy || !bootstrap} onClick={() => input.current?.click()}>
          {busy ? 'Uploading…' : 'Attach image'}
        </button>
        {error && <Notice>{error}</Notice>}
      </div>
    ),
  };
}
