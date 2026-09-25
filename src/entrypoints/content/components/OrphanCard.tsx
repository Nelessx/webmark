import { useEffect, useState } from 'react';
import { PriorityIcon } from '@/components/PriorityIcon';
import { pinNumber } from '@/lib/constants';
import { PRIORITY_LABELS, STATUS_LABELS } from '@/lib/noteMeta';
import type { Note } from '@/lib/types';
import { safeImageSrc } from '../dom';
import { useAppState, useWebmark } from './context';

/** Floating card (bottom-right) for a note whose element isn't on the page. */
export function OrphanCard({ note }: { note: Note }) {
  const { actions } = useWebmark();
  const notes = useAppState((s) => s.notes);
  const [screenshot, setScreenshot] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setScreenshot(undefined);
    if (note.hasScreenshot) {
      void actions.loadScreenshot(note.id).then((dataUrl) => {
        if (!cancelled) setScreenshot(safeImageSrc(dataUrl));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [actions, note.id, note.hasScreenshot]);

  const number = pinNumber(note.id, notes);

  return (
    <div
      className="wm-card"
      data-wm-orphan-card={note.id}
      role="dialog"
      aria-label={`WebMark note ${number}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') actions.closeOrphanCard();
      }}
    >
      <div className="wm-card__head">
        <span className="wm-card__num" data-status={note.status}>
          #{number}
        </span>
        <span className="wm-card__label">{note.label}</span>
        <button
          type="button"
          className="wm-icon-btn"
          aria-label="Close"
          data-wm-orphan-close=""
          onClick={actions.closeOrphanCard}
        >
          ×
        </button>
      </div>
      <p className="wm-card__notice">The element for this note isn't on the page right now.</p>
      {note.body && <div className="wm-card__body">{note.body}</div>}
      {screenshot && <img className="wm-card__shot" src={screenshot} alt="Screenshot of the element when the note was written" />}
      <div className="wm-card__foot">
        <span className="wm-card__props">
          <span className="wm-card__status" data-status={note.status}>
            {STATUS_LABELS[note.status]}
          </span>
          <span className="wm-card__priority" data-priority={note.priority}>
            <PriorityIcon priority={note.priority} />
            {PRIORITY_LABELS[note.priority]} priority
          </span>
        </span>
        <button type="button" className="wm-btn wm-btn--ghost" onClick={() => actions.openDashboard(note.id)}>
          Open in dashboard
        </button>
      </div>
    </div>
  );
}
