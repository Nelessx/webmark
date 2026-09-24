import { useLayoutEffect, useRef, useState } from 'react';
import { cx } from './cx';

export interface NoteBodyProps {
  text: string;
  /** Lines shown before "Show more" (CSS line clamp). */
  lines?: number;
  className?: string;
}

/** Plain-text note body (pre-wrap), clamped with a "Show more" toggle when it overflows. */
export function NoteBody({ text, lines = 6, className }: NoteBodyProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    // Re-measure when the container width changes (resizable side panel).
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded, lines]);

  if (!text.trim()) {
    return <p className={cx('wm-note-body', 'is-empty', className)}>No description</p>;
  }

  return (
    <div className={cx('wm-note-body-wrap', className)}>
      <p
        ref={ref}
        className={cx('wm-note-body', !expanded && 'is-clamped')}
        style={expanded ? undefined : { WebkitLineClamp: lines }}
      >
        {text}
      </p>
      {overflowing || expanded ? (
        <button type="button" className="wm-link-btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
