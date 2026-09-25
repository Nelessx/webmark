import type { ElementAnchor, Note, NoteStatus } from '../types';

/*
 * The isolated note editor. The form runs in an extension page
 * (note-editor.html) framed inside WebMark's closed shadow root, so the web
 * page never sees what the user types: keys, input, paste and IME events are
 * dispatched in the extension's document, not the page's.
 *
 *   content script ──wm:editor-open {token, request}──▶ background   registers the session
 *   content script: <iframe src="note-editor.html#token"> in the shadow root
 *   editor frame ──wm:editor-hello {token}──▶ background              checks the sender, single use
 *   editor frame ──wm:editor-emit {token, event}──▶ background ──wm:editor-event──▶ content script
 *
 * window.postMessage is never used: messages from a content script carry the
 * page's origin, and the page can forge or observe them. If the frame never
 * says hello (e.g. the page's COEP blocks extension frames) the content script
 * falls back to its in-page editor and says that typing there is visible.
 */

/** The editor page, as built by WXT from src/entrypoints/note-editor/. */
export const EDITOR_PAGE_PATH = '/note-editor.html';

/** A registered session must be claimed by its frame within this time. */
export const EDITOR_HELLO_TTL_MS = 60_000;

/** Without a hello by then the content script uses its in-page editor instead. */
export const EDITOR_CONNECT_TIMEOUT_MS = 1500;

export const INSECURE_EDITOR_WARNING = 'Typing here is visible to this page.';

/** The form's fields as typed (tags still comma separated). */
export interface EditorFields {
  label: string;
  body: string;
  tags: string;
  status: NoteStatus;
}

/** What a save writes: trimmed values with parsed tags. */
export interface EditorDraft {
  label: string;
  body: string;
  tags: string[];
  status: NoteStatus;
}

/** The draft fields the user changed in this editor session; an edit writes only those. */
export type EditedFields = readonly (keyof EditorDraft)[];

/** Unsaved values, and the values the form opened with (to tell which fields were edited). */
export interface DraftState {
  initial: EditorFields;
  values: EditorFields;
}

/** The page a note belongs to, fixed when the editor opens (an SPA may navigate while it is open). */
export interface EditorPage {
  pageKey: string;
  url: string;
  title: string;
}

interface RequestBase {
  page: EditorPage;
  /** Element label shown (and editable) in the form. */
  label: string;
  /** Start from these values instead of the note's (a draft restored after a reload). */
  draft?: DraftState;
}

export interface CreateRequest extends RequestBase {
  mode: 'create';
  anchor: ElementAnchor;
  /** JPEG data URL captured when the element was picked. */
  screenshot?: string;
}

export interface EditRequest extends RequestBase {
  mode: 'edit';
  noteId: string;
}

export type EditorRequest = CreateRequest | EditRequest;

/** What the background tells a frame that presented a valid token. */
export interface EditorSessionInfo {
  request: EditorRequest;
  tabId: number;
}

export type EditorHelloResponse = { ok: true; session: EditorSessionInfo } | { ok: false };

/** Events the editor frame reports; the background relays them to the content script. */
export type EditorFrameEvent =
  /** Height of the editor card in CSS px, to size the frame. */
  | { kind: 'height'; height: number }
  | { kind: 'dirty'; dirty: boolean }
  | { kind: 'saved'; note: Note }
  /** About to delete the note, so its disappearing isn't reported as "deleted elsewhere". */
  | { kind: 'deleting' }
  | { kind: 'deleted'; noteId: string }
  /** Closed without saving (Cancel, Esc, discard). */
  | { kind: 'closed' }
  | { kind: 'toast'; text: string; tone: 'info' | 'error' };

/** `connected` comes from the background once the frame's hello was accepted. */
export type EditorEvent = { kind: 'connected' } | EditorFrameEvent;

const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** 128 random bits. crypto.getRandomValues also works on plain-http pages, unlike randomUUID. */
export function createEditorToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isEditorToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function sameFields(a: EditorFields, b: EditorFields): boolean {
  return a.label === b.label && a.body === b.body && a.tags === b.tags && a.status === b.status;
}
