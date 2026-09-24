import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { getNotesForPage, type NotesChange } from '@/lib/storage';
import type { Note } from '@/lib/types';
import type { Timers } from './dom';
import type { NoteResolver } from './resolver';
import type { AppStore } from './store';

/** Loads the current page's notes and keeps them in step with storage. */
export class PageNotes {
  private loadSeq = 0;
  /** Bumped by storage change events, so a slower initial read never overwrites them. */
  private version = 0;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly store: AppStore,
    private readonly resolver: NoteResolver,
  ) {}

  /** Read the notes for the current page key, then resolve them (optionally after a delay). */
  async load(resolveDelayMs = 0): Promise<void> {
    const seq = ++this.loadSeq;
    const version = this.version;
    let notes: Note[] = [];
    try {
      notes = await getNotesForPage(this.store.get().pageKey);
    } catch {
      // Treat unreadable storage as "no notes" rather than breaking the page.
    }
    if (seq !== this.loadSeq || this.ctx.isInvalid) return;
    if (version === this.version) this.store.set({ notes });
    this.store.set({ notesLoaded: true });
    if (resolveDelayMs) this.resolver.syncSoon(resolveDelayMs);
    else this.resolver.sync();
  }

  /** Apply a storage change event. Returns true if it concerned the current page. */
  applyChange(changes: NotesChange[]): boolean {
    const change = changes.find((c) => c.pageKey === this.store.get().pageKey);
    if (!change) return false;
    this.version++;
    const stillExists = (id: string | null) => (id && change.notes.some((n) => n.id === id) ? id : null);
    this.store.set((s) => ({
      notes: change.notes,
      notesLoaded: true,
      orphanNoteId: stillExists(s.orphanNoteId),
      hoverNoteId: stillExists(s.hoverNoteId),
    }));
    this.resolver.sync();
    return true;
  }

  /** Forget the previous page's notes and resolution (SPA navigation). */
  switchTo(pageKey: string): void {
    this.loadSeq++;
    this.resolver.reset();
    this.store.set({
      pageKey,
      notes: [],
      notesLoaded: false,
      resolved: new Map(),
      resolvedOnce: false,
      orphanNoteId: null,
      hoverNoteId: null,
      flash: null,
    });
  }
}

/** Resolves with the note's element once it's resolved, or null after `ms`. */
export function waitForElement(store: AppStore, timers: Timers, noteId: string, ms: number): Promise<Element | null> {
  return new Promise((resolve) => {
    let timer = 0;
    const done = (el: Element | null) => {
      unsubscribe();
      timers.clear(timer);
      resolve(el);
    };
    const unsubscribe = store.subscribe(() => {
      const el = store.get().resolved.get(noteId);
      if (el) done(el);
    });
    timer = timers.set(() => done(null), ms);
  });
}
