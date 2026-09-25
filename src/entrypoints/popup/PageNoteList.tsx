import { EmptyState } from '@/components/EmptyState';
import { firstLine } from '@/components/filter';
import { IconAlertTriangle, IconPin } from '@/components/icons';
import { PinBadge } from '@/components/PinBadge';
import { pinNumber } from '@/lib/constants';
import { isArchivedStatus, STATUS_LABELS } from '@/lib/noteMeta';
import type { Note } from '@/lib/types';

interface PageNoteListProps {
  /** Every note of the page, oldest first (pin order). Archived ones aren't listed. */
  notes: Note[];
  orphanedIds: ReadonlySet<string>;
  onSelect: (noteId: string) => void;
}

/** Compact list of the page's notes; clicking one reveals it on the page. */
export function PageNoteList({ notes, orphanedIds, onSelect }: PageNoteListProps) {
  const shown = notes.filter((n) => !isArchivedStatus(n.status));

  if (!shown.length) {
    return notes.length ? (
      <EmptyState
        compact
        icon={<IconPin size={20} />}
        title="All notes on this page are archived"
        description="Find them under Archived in the side panel or on the All notes page."
      />
    ) : (
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
        {shown.map((note) => {
          // Numbered among all the page's notes, archived ones included, like the pins.
          const number = pinNumber(note.id, notes);
          const orphaned = orphanedIds.has(note.id);
          const preview = firstLine(note.body);
          const high = note.priority === 'high';
          return (
            <li key={note.id}>
              <button
                type="button"
                className="popup-note"
                data-status={note.status}
                data-priority={note.priority}
                onClick={() => onSelect(note.id)}
                title={orphaned ? 'Not found on this page' : 'Show on page'}
              >
                <PinBadge number={number} status={note.status} priority={note.priority} orphaned={orphaned} size="sm" />
                <span className="popup-note__text">
                  <span className="popup-note__label">{note.label || 'Untitled element'}</span>
                  {preview ? <span className="popup-note__body">{preview}</span> : null}
                </span>
                {orphaned ? (
                  <span className="popup-note__flag">
                    <IconAlertTriangle size={14} title="Not found on this page" />
                  </span>
                ) : null}
                <span className="wm-visually-hidden">
                  ({STATUS_LABELS[note.status]}
                  {high ? ', high priority' : ''})
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
