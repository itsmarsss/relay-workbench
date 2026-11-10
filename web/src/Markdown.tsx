import { useState } from 'react';
import { markdown } from './render-markdown';
import { Modal } from './Modal';
export function Markdown({ text }: { text: string }) {
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  return (
    <>
      <div
        className="prose"
        onClick={(event) => {
          const button = (event.target as HTMLElement).closest('button[data-action="view-image"]');
          const img = button?.querySelector('img');
          if (img) {
            event.preventDefault();
            setImage({ src: img.src, alt: img.alt });
          }
        }}
        dangerouslySetInnerHTML={{ __html: markdown(text) }}
      />
      {image && (
        <Modal title={image.alt || 'Image'} onClose={() => setImage(null)}>
          <img className="image-lightbox" src={image.src} alt={image.alt} />
        </Modal>
      )}
    </>
  );
}
