import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from './cx';
import { useScreenshot } from './hooks';
import { IconImage } from './icons';
import { Lightbox } from './Lightbox';

export interface ScreenshotThumbProps {
  noteId: string;
  /** Changes (e.g. note.updatedAt) trigger a re-read from storage. */
  version?: number;
  /** What the screenshot shows, e.g. the note label. */
  alt: string;
  /** Caption under the enlarged image. */
  caption?: ReactNode;
  className?: string;
}

/**
 * Screenshot preview that loads from storage only once it scrolls near the
 * viewport. Click (or Enter) opens it in a Lightbox. Renders nothing if the
 * note has no stored screenshot.
 */
export function ScreenshotThumb({ noteId, version, alt, caption, className }: ScreenshotThumbProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const { src, loading } = useScreenshot(noteId, visible, version);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  if (visible && !loading && !src) return null;

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx('wm-shot', !src && 'is-loading', className)}
        onClick={() => src && setOpen(true)}
        aria-label={`Enlarge screenshot: ${alt}`}
        title="Enlarge screenshot"
        disabled={!src}
      >
        {src ? (
          <img className="wm-shot__img" src={src} alt="" draggable={false} />
        ) : (
          <span className="wm-shot__placeholder">
            <IconImage />
          </span>
        )}
      </button>
      {open && src ? <Lightbox src={src} alt={alt} caption={caption} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
