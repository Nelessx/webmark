import { useEffect, useId, useRef, useState } from 'react';
import { formatRelativeTime, noteToMarkdown } from '@/lib/format';
import type { Note, NotePatch } from '@/lib/types';
import { displayPageKey, siteOf } from '@/lib/url';
import { IconButton } from './Button';
import { ConfirmButton } from './ConfirmButton';
import { cx } from './cx';
import { useNow, useToast } from './hooks';
import { IconAlertTriangle, IconCheck, IconCopy, IconCrosshair, IconPencil, IconRotateCcw, IconTrash } from './icons';
import { NoteBody } from './NoteBody';
import { NoteEditor } from './NoteEditor';
import { PinBadge } from './PinBadge';
import { copyText } from './platform';
import { ScreenshotThumb } from './ScreenshotThumb';
import { StatusBadge } from './StatusBadge';
import { TagList } from './TagList';

export interface NoteCardProps {
  note: Note;
  /** 1-based pin number (pinNumber()); omit to hide the pin badge. */
  pinNumber?: number;
  /** The note's element was not found on the page: grey pin + warning. */
  orphaned?: boolean;
  /** Show the page title and site under the label (dashboard). */
  showPage?: boolean;
  /** Accent ring; the card scrolls itself into view when this turns on. */
  highlighted?: boolean;
  /** Show a selection checkbox (bulk actions). */
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
  /** "Show on page": adds the crosshair action and makes the pin clickable. */
  onLocate?: () => void;
  /** Tooltip / accessible name for onLocate. */
  locateLabel?: string;
  /** Persist a change. May return a promise; a rejection shows an error toast. */
  onUpdate: (patch: NotePatch) => void | Promise<unknown>;
  /** Delete after the user confirmed (ConfirmButton). */
  onDelete: () => void | Promise<unknown>;
  /** Makes tags clickable (e.g. to filter by tag). */
  onTagClick?: (tag: string) => void;
  /** Tags rendered as selected when onTagClick is set. */
  activeTags?: readonly string[];
  className?: string;
}

function relativeTime(timestamp: number, now: number): string {
  try {
    return formatRelativeTime(timestamp, now);
  } catch {
    return new Date(timestamp).toLocaleDateString();
  }
}

/**
 * One note: label, body, tags, screenshot, meta and actions (locate,
 * resolve/reopen, copy as Markdown, edit inline, delete). Shows its own toasts
 * for these actions, so callers should not toast again.
 */
export function NoteCard({
  note,
  pinNumber,
  orphaned,
  showPage,
  highlighted,
  selectable,
  selected,
  onSelectChange,
  onLocate,
  locateLabel = 'Show on page',
  onUpdate,
  onDelete,
  onTagClick,
  activeTags,
  className,
}: NoteCardProps) {
  const [editing, setEditing] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const toast = useToast();
  const now = useNow();
  const headingId = useId();
  const resolved = note.status === 'resolved';
  const pinText = pinNumber ? `#${pinNumber}` : '';

  // Return focus to the Edit button when the inline editor closes.
  useEffect(() => {
    if (wasEditing.current && !editing) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  useEffect(() => {
    if (highlighted) rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlighted]);

  const update = async (patch: NotePatch, success?: string) => {
    try {
      await onUpdate(patch);
      if (success) toast(success, { tone: 'success' });
    } catch {
      toast('Could not save the note', { tone: 'danger' });
      throw new Error('update failed');
    }
  };

  const toggleStatus = () => {
    void update({ status: resolved ? 'open' : 'resolved' }, resolved ? 'Note reopened' : 'Marked as resolved').catch(
      () => undefined,
    );
  };

  const saveEdits = async (patch: NotePatch) => {
    await update(patch);
    setEditing(false);
  };

  const copyMarkdown = async () => {
    let ok = false;
    try {
      ok = await copyText(noteToMarkdown(note));
    } catch {
      ok = false;
    }
    toast(ok ? 'Copied as Markdown' : 'Could not copy to the clipboard', { tone: ok ? 'success' : 'danger' });
  };

  const remove = async () => {
    try {
      await onDelete();
      toast('Note deleted');
    } catch {
      toast('Could not delete the note', { tone: 'danger' });
    }
  };

  // Imported notes can carry bad timestamps; toISOString() would throw on them.
  const created = new Date(note.createdAt);
  const createdValid = Number.isFinite(created.getTime());
  const timeTitle = createdValid
    ? `Created ${created.toLocaleString()}` +
      (note.updatedAt - note.createdAt > 60_000 ? `\nUpdated ${new Date(note.updatedAt).toLocaleString()}` : '')
    : undefined;

  return (
    <article
      ref={rootRef}
      className={cx(
        'wm-note-card',
        resolved && 'is-resolved',
        orphaned && 'is-orphaned',
        highlighted && 'is-highlighted',
        selected && 'is-selected',
        editing && 'is-editing',
        className,
      )}
      data-note-id={note.id}
      aria-labelledby={headingId}
    >
      <div className="wm-note-card__head">
        {selectable ? (
          <input
            type="checkbox"
            className="wm-checkbox wm-note-card__select"
            checked={!!selected}
            onChange={(e) => onSelectChange?.(e.target.checked)}
            aria-label={`Select note ${pinText} ${note.label}`.replace(/\s+/g, ' ')}
          />
        ) : null}
        {pinNumber !== undefined ? (
          <PinBadge
            number={pinNumber}
            status={note.status}
            orphaned={orphaned}
            onClick={onLocate}
            label={onLocate ? `${locateLabel} (${pinText})` : undefined}
          />
        ) : null}
        <div className="wm-note-card__title">
          <h3 id={headingId} className="wm-note-card__label" title={note.label}>
            {note.label || 'Untitled element'}
          </h3>
          {showPage ? (
            <p className="wm-note-card__page" title={note.url}>
              <span className="wm-note-card__page-title">{note.pageTitle || displayPageKey(note.pageKey)}</span>
              <span className="wm-note-card__site">{siteOf(note.pageKey)}</span>
            </p>
          ) : null}
        </div>
        <StatusBadge status={note.status} className="wm-note-card__status" />
      </div>

      {editing ? (
        <NoteEditor note={note} onSave={saveEdits} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <NoteBody text={note.body} />
          {orphaned ? (
            <p className="wm-note-card__warning">
              <IconAlertTriangle size={14} />
              <span>Not found on page. The element may have changed or been removed.</span>
            </p>
          ) : null}
          {note.hasScreenshot ? (
            <ScreenshotThumb
              noteId={note.id}
              version={note.updatedAt}
              alt={`Screenshot of ${note.label || 'the element'}`}
              caption={note.label}
            />
          ) : null}
          <TagList tags={note.tags} onTagClick={onTagClick} activeTags={activeTags} label="Tags" />
          <div className="wm-note-card__foot">
            <p className="wm-note-card__meta">
              {note.author ? <span className="wm-note-card__author">{note.author}</span> : null}
              <time dateTime={createdValid ? created.toISOString() : undefined} title={timeTitle}>
                {relativeTime(note.createdAt, now)}
              </time>
            </p>
            <div className="wm-note-card__actions">
              {onLocate ? (
                <IconButton size="sm" label={locateLabel} icon={<IconCrosshair />} onClick={onLocate} />
              ) : null}
              <IconButton
                size="sm"
                label={resolved ? 'Reopen' : 'Mark as resolved'}
                icon={resolved ? <IconRotateCcw /> : <IconCheck />}
                onClick={toggleStatus}
              />
              <IconButton size="sm" label="Copy as Markdown" icon={<IconCopy />} onClick={() => void copyMarkdown()} />
              <IconButton
                ref={editButtonRef}
                size="sm"
                label="Edit note"
                icon={<IconPencil />}
                onClick={() => setEditing(true)}
              />
              <ConfirmButton
                iconOnly
                size="sm"
                variant="danger"
                label="Delete note"
                confirmLabel="Delete?"
                icon={<IconTrash />}
                onConfirm={() => void remove()}
              />
            </div>
          </div>
        </>
      )}
    </article>
  );
}
