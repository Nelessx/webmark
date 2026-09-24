import { cx } from '@/components/cx';
import { EmptyState } from '@/components/EmptyState';
import { firstLine } from '@/components/filter';
import { IconAlertTriangle, IconPin } from '@/components/icons';
import { PinBadge } from '@/components/PinBadge';
import { pinNumber } from '@/lib/constants';
import type { Note } from '@/lib/types';

interface PageNoteListProps {
  /** The page's notes, oldest first (pin order). */
  notes: Note[];
  orphanedIds: ReadonlySet<string>;
  onSelect: (noteId: string) => void;
}

/** Compact list of the page's notes; clicking one reveals it on the page. */
export function PageNoteList({ notes, orphanedIds, onSelect }: PageNoteListProps) {
  if (!notes.length) {
    return (
      <EmptyState
        compact
        icon={<IconPin size={20} />}
        title="No notes on this page yet"
        description="Click Add note, then pick any element on the page to attach feedback to it."
      />
    );
  }

  return (
    <section className="popup-list" aria-labelledby="popup-list-title">
      <h2 id="popup-list-title" className="wm-section-title popup-list__title">
        On this page
      </h2>
      <ul className="popup-notes">
        {notes.map((note) => {
          const number = pinNumber(note.id, notes);
          const orphaned = orphanedIds.has(note.id);
          const preview = firstLine(note.body);
          return (
            <li key={note.id}>
              <button
                type="button"
                className={cx('popup-note', note.status === 'resolved' && 'is-resolved')}
                onClick={() => onSelect(note.id)}
                title={orphaned ? 'Not found on this page' : 'Show on page'}
              >
                <PinBadge number={number} status={note.status} orphaned={orphaned} size="sm" />
                <span className="popup-note__text">
                  <span className="popup-note__label">{note.label || 'Untitled element'}</span>
                  {preview ? <span className="popup-note__body">{preview}</span> : null}
                </span>
                {orphaned ? (
                  <span className="popup-note__flag">
                    <IconAlertTriangle size={14} title="Not found on this page" />
                  </span>
                ) : null}
                {note.status === 'resolved' ? <span className="wm-visually-hidden">(resolved)</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
