import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './icons';

export interface LightboxProps {
  src: string;
  /** Describes the image; also the dialog's accessible name. */
  alt: string;
  caption?: ReactNode;
  onClose: () => void;
}

/**
 * Full-screen image viewer on a native modal <dialog>: focus is trapped and
 * restored by the browser, Esc closes. Clicking anywhere closes too. Mount it
 * only while open.
 */
export function Lightbox({ src, alt, caption, onClose }: LightboxProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    // No close in cleanup: StrictMode's re-run would fire onClose immediately.
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className="wm-lightbox"
      aria-label={alt}
      onClose={onClose}
      onClick={(event) => {
        // React events bubble through portals: keep clicks from reaching the card behind.
        event.stopPropagation();
        ref.current?.close();
      }}
    >
      <figure className="wm-lightbox__figure">
        <img className="wm-lightbox__img" src={src} alt={alt} />
        {caption ? <figcaption className="wm-lightbox__caption">{caption}</figcaption> : null}
      </figure>
      <button type="button" className="wm-lightbox__close" aria-label="Close" title="Close (Esc)" autoFocus>
        <IconX size={18} />
      </button>
    </dialog>,
    document.body,
  );
}
