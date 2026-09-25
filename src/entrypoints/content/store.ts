import type { DraftState, EditorPage } from '@/lib/editor/protocol';
import { DEFAULT_SETTINGS, type ElementAnchor, type Note, type Settings } from '@/lib/types';
import type { FocusableElement } from './dom';

/*
 * Tiny external store for the content script. React reads it through
 * useSyncExternalStore; non-React modules subscribe directly. State is
 * replaced immutably so selectors can return fields by reference.
 */

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const key in next) {
        if (!Object.is(next[key], state[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Where the note form lives. */
export type EditorSurface =
  /**
   * The isolated editor frame: `registering` the session with the background,
   * frame `loading`, then `connected` once its hello was accepted. `height`
   * is the form's height as the frame reports it (0 until then).
   */
  | { kind: 'frame'; phase: 'registering' | 'loading' | 'connected'; height: number }
  /** The in-page fallback, where the page can see what is typed. */
  | { kind: 'inline' };

export interface EditorSession {
  /** Changes every time an editor opens, so React remounts the form. */
  id: number;
  /** Names the session to the background and the editor frame (secret: never in the page's DOM). */
  token: string;
  mode: 'create' | 'edit';
  /** The page element the note is about; null if it can't be found (e.g. a draft restored after a reload). */
  target: Element | null;
  /** Existing note being edited (edit mode). */
  noteId?: string;
  /** The edited note as it was when the editor opened (edit mode). */
  note?: Note;
  /** Anchor captured when the element was picked (create mode). */
  anchor?: ElementAnchor;
  label: string;
  /** Screenshot captured at pick time (create mode). */
  screenshot?: string;
  /** Page element to give focus back to when the editor closes. */
  returnFocus: FocusableElement | null;
  /** The page the note belongs to, fixed at open: an SPA may navigate while the editor is open. */
  page: EditorPage;
  /** Unsaved values to start from (restored after a reload). */
  draft?: DraftState;
  surface: EditorSurface;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface AppState {
  pageKey: string;
  /** False until the notes for pageKey have been read from storage. */
  notesLoaded: boolean;
  /** Notes for pageKey, oldest first (pin order). */
  notes: Note[];
  /** noteId → element the note's anchor resolved to. */
  resolved: ReadonlyMap<string, Element>;
  /** True once the first resolution pass for pageKey has run. */
  resolvedOnce: boolean;
  settings: Settings;
  pickerActive: boolean;
  editor: EditorSession | null;
  /** Bumped to make the open editor grab focus and shake (e.g. "finish this note first"). */
  editorNudge: number;
  /** Note shown in the floating "element not found" card. */
  orphanNoteId: string | null;
  hoverNoteId: string | null;
  flash: { id: number; element: Element } | null;
  toasts: Toast[];
  /** The page's open modal dialog, which our host has moved into (see modalHost.ts): only its content gets pins. */
  modal: Element | null;
}

export type AppStore = Store<AppState>;

export function createAppStore(pageKey: string): AppStore {
  return createStore<AppState>({
    pageKey,
    notesLoaded: false,
    notes: [],
    resolved: new Map(),
    resolvedOnce: false,
    settings: DEFAULT_SETTINGS,
    pickerActive: false,
    editor: null,
    editorNudge: 0,
    orphanNoteId: null,
    hoverNoteId: null,
    flash: null,
    toasts: [],
    modal: null,
  });
}

/** True for elements behind the page's open modal dialog: inert, under its backdrop. */
export function outsideModal(modal: Element | null, element: Element): boolean {
  return !!modal && !modal.contains(element);
}

export function findNote(state: AppState, noteId: string | null | undefined): Note | undefined {
  return noteId ? state.notes.find((n) => n.id === noteId) : undefined;
}

/** Page elements the layout tracker must measure for the current UI. */
export function selectLayoutTargets(s: AppState): Element[] {
  const targets = new Set<Element>();
  if (s.settings.pinsVisible) s.resolved.forEach((el) => targets.add(el));
  const hovered = s.hoverNoteId ? s.resolved.get(s.hoverNoteId) : undefined;
  if (hovered) targets.add(hovered);
  if (s.editor?.target) targets.add(s.editor.target);
  if (s.flash) targets.add(s.flash.element);
  return [...targets];
}
