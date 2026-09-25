import { parseTags } from '../format';
import { createNoteId, saveNote, saveScreenshot, updateNote } from '../storage';
import { NOTE_SCHEMA_VERSION, type Note, type NotePatch } from '../types';
import type { CreateRequest, EditedFields, EditorDraft, EditorFields } from './protocol';

/*
 * Saving from the note editor, shared by the isolated editor frame and the
 * in-page fallback editor.
 */

/** crypto.randomUUID only exists in secure contexts; plain-http pages still need ids. */
export function newNoteId(): string {
  try {
    return createNoteId();
  } catch {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

/** Form values → what gets stored. An emptied label falls back to the element's label. */
export function toDraft(values: EditorFields, fallbackLabel: string): EditorDraft {
  return {
    label: values.label.trim() || fallbackLabel,
    body: values.body.trim(),
    tags: parseTags(values.tags),
    status: values.status,
  };
}

/** The fields that differ from the values the form opened with. */
export function editedFields(values: EditorFields, initial: EditorFields): EditedFields {
  return (Object.keys(initial) as (keyof EditorFields)[]).filter((key) => values[key] !== initial[key]);
}

/** Store a new note for a picked element (screenshot first, so listeners can load it right away). */
export async function createNote(request: CreateRequest, draft: EditorDraft, author: string): Promise<Note> {
  const id = newNoteId();
  let hasScreenshot = false;
  if (request.screenshot) {
    try {
      await saveScreenshot(id, request.screenshot);
      hasScreenshot = true;
    } catch {
      // Keep the note even if the (large) screenshot couldn't be stored.
    }
  }
  const now = Date.now();
  const note: Note = {
    id,
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: request.page.pageKey,
    url: request.page.url,
    pageTitle: request.page.title,
    label: draft.label,
    body: draft.body,
    status: 'open',
    tags: draft.tags,
    author,
    anchor: request.anchor,
    hasScreenshot,
    createdAt: now,
    updatedAt: now,
  };
  await saveNote(note);
  return note;
}

/**
 * Write only the `edited` fields: the others may have changed elsewhere while
 * the editor was open (e.g. resolved from the dashboard) and must not be
 * overwritten with the values the editor opened with. Resolves undefined if
 * the note no longer exists.
 */
export function updateEditedFields(
  pageKey: string,
  noteId: string,
  draft: EditorDraft,
  edited: EditedFields,
): Promise<Note | undefined> {
  const patch: NotePatch = {};
  if (edited.includes('label')) patch.label = draft.label;
  if (edited.includes('body')) patch.body = draft.body;
  if (edited.includes('tags')) patch.tags = draft.tags;
  if (edited.includes('status')) patch.status = draft.status;
  return updateNote(pageKey, noteId, patch);
}
