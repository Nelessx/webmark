import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { buildLabel, createAnchor, describeElement } from '@/lib/anchor';
import { noteToMarkdown } from '@/lib/format';
import { createNoteId, deleteNote, saveNote, saveScreenshot, updateNote } from '@/lib/storage';
import { NOTE_SCHEMA_VERSION, type ElementAnchor, type Note, type NotePatch, type NoteStatus } from '@/lib/types';
import { getPageKey } from '@/lib/url';
import { captureElement } from './capture';
import { copyText } from './clipboard';
import { pageFocus, restorePageFocus, type FocusableElement } from './dom';
import type { NoteResolver } from './resolver';
import { findNote, type AppStore, type EditorSession } from './store';
import type { Toaster } from './toasts';

export interface EditorDraft {
  label: string;
  body: string;
  tags: string[];
  status: NoteStatus;
}

/** The draft fields the user changed in this editor session. */
export type EditedFields = readonly (keyof EditorDraft)[];

export interface EditorDeps {
  ctx: ContentScriptContext;
  store: AppStore;
  resolver: NoteResolver;
  toaster: Toaster;
  host: HTMLElement;
  /** Where the clipboard fallback puts its temporary textarea (inside the shadow root). */
  uiContainer: HTMLElement;
}

function labelFor(el: Element): string {
  try {
    const label = buildLabel(el).trim();
    if (label) return label;
  } catch {
    // Fall through to the technical description.
  }
  try {
    return describeElement(el);
  } catch {
    return el.tagName.toLowerCase();
  }
}

/** crypto.randomUUID only exists in secure contexts; plain-http pages still need ids. */
function newNoteId(): string {
  try {
    return createNoteId();
  } catch {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

/** Opening, closing, saving and deleting through the note editor popover. */
export class EditorController {
  private seq = 0;
  private dirty = false;
  private opening = false;
  /** Page focus just before the last press on WebMark's UI (a pin click moves focus into our shadow root). */
  private focusBeforeUiPress: FocusableElement | null = null;

  constructor(private readonly deps: EditorDeps) {
    deps.ctx.addEventListener(
      document,
      'pointerdown',
      (event) => {
        if (event.composedPath().includes(deps.host)) {
          this.focusBeforeUiPress = pageFocus();
          return;
        }
        // Clicking the page closes an untouched editor; a draft with changes stays open.
        if (deps.store.get().editor && !this.dirty) this.close(false);
      },
      { capture: true, passive: true },
    );
  }

  /** True while a picked element is being anchored/screenshotted. */
  get busy(): boolean {
    return this.opening;
  }

  setDirty(dirty: boolean): void {
    this.dirty = dirty;
  }

  /** Make the open editor grab focus and shake. */
  nudge(): void {
    this.deps.store.set((s) => ({ editorNudge: s.editorNudge + 1 }));
  }

  /** Close a clean editor so another flow can start; refuse (and nudge) if it has unsaved changes. */
  release(): boolean {
    if (!this.deps.store.get().editor) return true;
    if (this.dirty) {
      this.nudge();
      this.deps.toaster.show('Save or discard the open note first');
      return false;
    }
    this.close();
    return true;
  }

  /** New-note flow for a picked element: anchor it, optionally screenshot it, then open the editor. */
  async openForElement(el: Element, capture: boolean): Promise<void> {
    const { store, toaster, host, ctx } = this.deps;
    if (this.opening) return;
    this.opening = true;
    try {
      const returnFocus = pageFocus();
      let anchor: ElementAnchor;
      try {
        anchor = createAnchor(el);
      } catch {
        toaster.show("WebMark couldn't read that element", 'error');
        return;
      }
      const label = labelFor(el);
      const screenshot =
        capture && store.get().settings.captureScreenshots ? await captureElement(el, host) : undefined;
      const { editor, pickerActive } = store.get();
      if (ctx.isInvalid || !el.isConnected || editor || pickerActive) return;
      this.open({ mode: 'create', target: el, anchor, label, screenshot, returnFocus });
    } finally {
      this.opening = false;
    }
  }

  /** Edit an existing, resolved note. Returns false if it can't be opened right now. */
  openNote(noteId: string): boolean {
    const state = this.deps.store.get();
    const note = findNote(state, noteId);
    const el = state.resolved.get(noteId);
    if (!note || !el) return false;
    if (state.editor?.noteId === noteId) {
      this.nudge();
      return true;
    }
    if (!this.release()) return false;
    const returnFocus = pageFocus() ?? this.focusBeforeUiPress;
    this.open({ mode: 'edit', target: el, noteId, label: note.label, returnFocus });
    return true;
  }

  /** Keep an edit session attached to its note's element when an SPA re-renders it. */
  followResolvedTarget(): void {
    const { editor, resolved } = this.deps.store.get();
    if (editor?.mode !== 'edit' || !editor.noteId) return;
    const el = resolved.get(editor.noteId);
    if (el && el !== editor.target) this.deps.store.set({ editor: { ...editor, target: el } });
  }

  close(restoreFocus = true): void {
    const { editor } = this.deps.store.get();
    if (!editor) return;
    this.dirty = false;
    this.deps.store.set({ editor: null });
    if (restoreFocus) restorePageFocus(editor.returnFocus);
  }

  /** Create the note, or write the `edited` fields of an existing one. */
  async save(draft: EditorDraft, edited: EditedFields): Promise<boolean> {
    const { store, toaster } = this.deps;
    const session = store.get().editor;
    if (!session || !draft.body.trim()) return false;
    try {
      if (session.mode === 'create') {
        await this.createNote(session, draft);
      } else if (session.noteId) {
        const pageKey = findNote(store.get(), session.noteId)?.pageKey ?? store.get().pageKey;
        // Only what was edited here: the other fields may have changed elsewhere
        // while the editor was open (e.g. resolved from the dashboard) and must
        // not be overwritten with the values the editor opened with.
        const patch: NotePatch = {};
        if (edited.includes('label')) patch.label = draft.label;
        if (edited.includes('body')) patch.body = draft.body;
        if (edited.includes('tags')) patch.tags = draft.tags;
        if (edited.includes('status')) patch.status = draft.status;
        const updated = await updateNote(pageKey, session.noteId, patch);
        if (!updated) {
          toaster.show('This note no longer exists', 'error');
          this.closeSession(session.id);
          return false;
        }
      }
    } catch {
      toaster.show("Couldn't save the note", 'error');
      return false;
    }
    this.closeSession(session.id);
    toaster.show('Note saved');
    return true;
  }

  async remove(noteId: string): Promise<void> {
    const { store, toaster } = this.deps;
    const note = findNote(store.get(), noteId);
    if (!note) return;
    if (store.get().editor?.noteId === noteId) this.close();
    try {
      await deleteNote(note.pageKey, noteId);
      toaster.show('Note deleted');
    } catch {
      toaster.show("Couldn't delete the note", 'error');
    }
  }

  async copyMarkdown(note: Note): Promise<void> {
    const ok = await copyText(noteToMarkdown(note), this.deps.uiContainer);
    this.deps.toaster.show(ok ? 'Copied to clipboard' : "Couldn't copy to the clipboard", ok ? 'info' : 'error');
  }

  private open(session: Omit<EditorSession, 'id'>): void {
    this.dirty = false;
    this.deps.store.set({ editor: { ...session, id: ++this.seq }, orphanNoteId: null, hoverNoteId: null });
  }

  private closeSession(sessionId: number): void {
    if (this.deps.store.get().editor?.id === sessionId) this.close();
  }

  private async createNote(session: EditorSession, draft: EditorDraft): Promise<void> {
    const { store, resolver } = this.deps;
    if (!session.anchor) throw new Error('Missing anchor');
    const id = newNoteId();
    let hasScreenshot = false;
    // Screenshot first, so pages listening for the new note can load it immediately.
    if (session.screenshot) {
      try {
        await saveScreenshot(id, session.screenshot);
        hasScreenshot = true;
      } catch {
        // Keep the note even if the (large) screenshot couldn't be stored.
      }
    }
    const now = Date.now();
    const note: Note = {
      id,
      schemaVersion: NOTE_SCHEMA_VERSION,
      pageKey: getPageKey(location.href),
      url: location.href,
      pageTitle: document.title,
      label: draft.label,
      body: draft.body,
      status: 'open',
      tags: draft.tags,
      author: store.get().settings.authorName,
      anchor: session.anchor,
      hasScreenshot,
      createdAt: now,
      updatedAt: now,
    };
    await saveNote(note);

    // Show the pin on the element we know, without waiting for storage.onChanged.
    if (note.pageKey !== store.get().pageKey) return;
    if (!findNote(store.get(), id)) store.set((s) => ({ notes: [...s.notes, note] }));
    if (!store.get().resolved.has(id) && session.target.isConnected) resolver.adopt(note, session.target);
  }
}
