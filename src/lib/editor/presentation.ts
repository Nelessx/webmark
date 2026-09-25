import { formatRelativeTime } from '../format';
import type { Note } from '../types';
import type { EditorFields } from './protocol';

/** The form's values for a new note (no `note`) or an existing one. */
export function initialFields(label: string, note: Note | undefined): EditorFields {
  return {
    label,
    body: note?.body ?? '',
    tags: note?.tags.join(', ') ?? '',
    status: note?.status ?? 'open',
  };
}

/** Heading and accessible name; `number` is the note's pin number (edit mode). */
export function editorTitles(mode: 'create' | 'edit', number: number): { title: string; ariaLabel: string } {
  return mode === 'edit'
    ? { title: `Note #${number}`, ariaLabel: `WebMark note ${number}` }
    : { title: 'New note', ariaLabel: 'New WebMark note' };
}

/** "Dana · created 2 h ago" for a note, "Posting as Dana" for a new one. */
export function editorMeta(mode: 'create' | 'edit', note: Note | undefined, authorName: string): string {
  if (mode === 'edit') {
    return [note?.author, note && `created ${formatRelativeTime(note.createdAt)}`].filter(Boolean).join(' · ');
  }
  return authorName ? `Posting as ${authorName}` : '';
}
