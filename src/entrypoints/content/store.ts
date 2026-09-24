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

export interface EditorSession {
  /** Changes every time an editor opens, so React remounts the form. */
  id: number;
  mode: 'create' | 'edit';
  target: Element;
  /** Existing note being edited (edit mode). */
  noteId?: string;
  /** Anchor captured when the element was picked (create mode). */
  anchor?: ElementAnchor;
  label: string;
  /** Screenshot captured at pick time (create mode). */
  screenshot?: string;
  /** Page element to give focus back to when the editor closes. */
  returnFocus: FocusableElement | null;
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
  });
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
  if (s.editor) targets.add(s.editor.target);
  if (s.flash) targets.add(s.flash.element);
  return [...targets];
}
