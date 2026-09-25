import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { buildLabel, createAnchor, describeElement, resolveAnchor } from '@/lib/anchor';
import { isWebmarkNode } from '@/lib/constants';
import {
  createEditorToken,
  EDITOR_CONNECT_TIMEOUT_MS,
  sameFields,
  type DraftState,
  type EditedFields,
  type EditorDraft,
  type EditorEvent,
  type EditorFields,
  type EditorPage,
  type EditorRequest,
} from '@/lib/editor/protocol';
import { createNote, updateEditedFields } from '@/lib/editor/save';
import { noteToMarkdown } from '@/lib/format';
import { sendToBackground } from '@/lib/messages';
import { deleteNote, type NotesChange } from '@/lib/storage';
import type { ElementAnchor, Note } from '@/lib/types';
import { getPageKey } from '@/lib/url';
import { captureElement } from './capture';
import { copyText } from './clipboard';
import { pageFocus, restorePageFocus, type FocusableElement, type Timers } from './dom';
import type { NoteResolver } from './resolver';
import { findNote, type AppStore, type EditorSession, type EditorSurface } from './store';
import type { Toaster } from './toasts';

export type { EditedFields, EditorDraft } from '@/lib/editor/protocol';

export interface EditorDeps {
  ctx: ContentScriptContext;
  store: AppStore;
  resolver: NoteResolver;
  toaster: Toaster;
  timers: Timers;
  host: HTMLElement;
  /** Where the clipboard fallback puts its temporary textarea (inside the shadow root). */
  uiContainer: HTMLElement;
}

/** An editor to open; open() adds the id, token and surface. */
type NewSession = Omit<EditorSession, 'id' | 'token' | 'surface'>;

/** How often the in-page fallback editor sends its unsaved values to the background. */
const DRAFT_MIRROR_MS = 400;
/** New frames tried for one editor after its frame broke, before editing moves into the page. */
const MAX_RECONNECTS = 3;

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

function currentPage(): EditorPage {
  return { pageKey: getPageKey(location.href), url: location.href, title: document.title };
}

function findElement(anchor: ElementAnchor): Element | null {
  try {
    const el = resolveAnchor(anchor)?.element;
    return el?.isConnected && !isWebmarkNode(el) ? el : null;
  } catch {
    return null;
  }
}

/** An open editor, minus what identifies its session: to open it again in a new one. */
function reopened({ id: _id, token: _token, surface: _surface, ...session }: EditorSession): NewSession {
  return session;
}

/** What the background keeps for the session and hands to the editor frame. */
function toRequest(session: NewSession): EditorRequest | null {
  const base = { page: session.page, label: session.label, ...(session.draft ? { draft: session.draft } : {}) };
  if (session.mode === 'create') {
    if (!session.anchor) return null;
    return { ...base, mode: 'create', anchor: session.anchor, ...(session.screenshot ? { screenshot: session.screenshot } : {}) };
  }
  return session.noteId ? { ...base, mode: 'edit', noteId: session.noteId } : null;
}

/**
 * Opening, closing, saving and deleting through the note editor. The form
 * normally runs in the isolated editor frame (FrameEditor); if that frame
 * doesn't connect, the in-page Editor takes over.
 */
export class EditorController {
  private seq = 0;
  private dirty = false;
  private opening = false;
  /** This tab's editor is deleting its note, so the note vanishing from storage isn't news. */
  private deletingId: string | null = null;
  private connectTimer: number | undefined;
  /** Frames replaced for the open editor so far (see fallback). */
  private reconnects = 0;
  private draftTimer: number | undefined;
  private pendingDraft: { token: string; draft: DraftState | null } | null = null;
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
      // The note belongs to the page it was picked on, even if an SPA navigates meanwhile.
      const page = currentPage();
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
      this.reconnects = 0;
      this.open({ mode: 'create', target: el, anchor, label, screenshot, returnFocus, page });
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
    const page = { pageKey: note.pageKey, url: note.url, title: note.pageTitle };
    this.reconnects = 0;
    this.open({ mode: 'edit', target: el, noteId, note, label: note.label, returnFocus, page });
    return true;
  }

  /** Reopen a draft this tab left unsaved (the page was reloaded while the editor had changes). */
  restore(request: EditorRequest): boolean {
    const { store, resolver, toaster } = this.deps;
    const state = store.get();
    if (state.editor || state.pickerActive || this.opening) return false;
    const base = { label: request.label, returnFocus: pageFocus(), page: request.page, draft: request.draft };
    this.reconnects = 0;
    if (request.mode === 'edit') {
      const note = findNote(state, request.noteId);
      if (!note) return false;
      this.open({ ...base, mode: 'edit', target: resolver.elementFor(note.id), noteId: note.id, note });
    } else {
      const target = findElement(request.anchor);
      this.open({ ...base, mode: 'create', target, anchor: request.anchor, screenshot: request.screenshot });
    }
    toaster.show('Restored an unsaved note');
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
    const { store, timers } = this.deps;
    const { editor } = store.get();
    if (!editor) return;
    this.dirty = false;
    this.deletingId = null;
    timers.clear(this.connectTimer);
    timers.clear(this.draftTimer);
    this.connectTimer = this.draftTimer = undefined;
    this.pendingDraft = null;
    store.set({ editor: null });
    void sendToBackground({ type: 'wm:editor-close', token: editor.token });
    if (restoreFocus) restorePageFocus(editor.returnFocus);
  }

  /** SPA navigation: an untouched editor closes, one with changes stays (its page was fixed when it opened). */
  closeIfUntouched(): void {
    if (!this.dirty) this.close(false);
  }

  /** Close an edit whose note was deleted somewhere else. */
  onNotesChanged(changes: NotesChange[]): void {
    const { store, toaster } = this.deps;
    const editor = store.get().editor;
    if (editor?.mode !== 'edit' || !editor.noteId || editor.noteId === this.deletingId) return;
    const change = changes.find((c) => c.pageKey === editor.page.pageKey);
    if (!change || change.notes.some((n) => n.id === editor.noteId)) return;
    this.close();
    toaster.show('This note was deleted');
  }

  // --- In-page fallback editor ---------------------------------------------

  /** Create the note, or write the `edited` fields of an existing one. */
  async save(draft: EditorDraft, edited: EditedFields): Promise<boolean> {
    const { store, toaster } = this.deps;
    const session = store.get().editor;
    const request = session && toRequest(session);
    if (!session || !request || !draft.body.trim()) return false;
    let saved: Note | undefined;
    try {
      if (request.mode === 'create') {
        saved = await createNote(request, draft, store.get().settings.authorName);
      } else {
        saved = await updateEditedFields(request.page.pageKey, request.noteId, draft, edited);
        if (!saved) {
          toaster.show('This note no longer exists', 'error');
          this.closeSession(session.id);
          return false;
        }
      }
    } catch {
      toaster.show("Couldn't save the note", 'error');
      return false;
    }
    this.finishSave(session, saved);
    return true;
  }

  async remove(noteId: string): Promise<void> {
    const { store, toaster } = this.deps;
    const { editor } = store.get();
    const note = findNote(store.get(), noteId) ?? (editor?.noteId === noteId ? editor.note : undefined);
    if (!note) return;
    if (editor?.noteId === noteId) this.close();
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

  /** Keep the background's copy of the fallback editor's unsaved values current, for recovery after a reload. */
  mirrorDraft(values: EditorFields, initial: EditorFields): void {
    const editor = this.deps.store.get().editor;
    if (editor?.surface.kind !== 'inline') return;
    this.pendingDraft = { token: editor.token, draft: sameFields(values, initial) ? null : { initial, values } };
    this.draftTimer ??= this.deps.timers.set(() => this.flushDraft(), DRAFT_MIRROR_MS);
  }

  // --- Isolated editor frame --------------------------------------------------

  /** An event from this tab's editor frame, relayed by the background. False if it isn't the open editor's. */
  onFrameEvent(token: string, event: EditorEvent): boolean {
    const { store, toaster, timers } = this.deps;
    const editor = store.get().editor;
    if (editor?.token !== token || editor.surface.kind !== 'frame') return false;
    const { surface } = editor;
    switch (event.kind) {
      case 'connected':
        timers.clear(this.connectTimer);
        this.connectTimer = undefined;
        this.setSurface(editor.id, { ...surface, phase: 'connected' });
        break;
      case 'height':
        this.setSurface(editor.id, { ...surface, height: event.height });
        break;
      case 'dirty':
        this.dirty = event.dirty;
        break;
      case 'saved':
        this.finishSave(editor, event.note);
        break;
      case 'deleting':
        this.deletingId = editor.noteId ?? null;
        break;
      case 'deleted':
        this.close();
        toaster.show('Note deleted');
        break;
      case 'closed':
        this.close();
        break;
      case 'toast':
        toaster.show(event.text, event.tone);
        break;
    }
    return true;
  }

  /**
   * The frame loaded again, so its session is spent: the page removed and
   * re-inserted our host (a Turbo-style <body> swap, say), which reloads frames.
   */
  frameFailed(sessionId: number): void {
    void this.fallback(sessionId, true);
  }

  // --- Internals ------------------------------------------------------------

  private open(session: NewSession): void {
    const request = toRequest(session);
    if (!request) return;
    const id = ++this.seq;
    const token = createEditorToken();
    this.dirty = !!session.draft && !sameFields(session.draft.values, session.draft.initial);
    this.deletingId = null;
    const surface: EditorSurface = { kind: 'frame', phase: 'registering', height: 0 };
    this.deps.store.set({ editor: { ...session, id, token, surface }, orphanNoteId: null, hoverNoteId: null });
    void this.connect(id, token, request);
  }

  /** Register the session, then let FrameEditor load the frame; fall back if it isn't connected in time. */
  private async connect(id: number, token: string, request: EditorRequest): Promise<void> {
    const { ctx, store, timers } = this.deps;
    this.connectTimer = timers.set(() => void this.fallback(id), EDITOR_CONNECT_TIMEOUT_MS);
    const response = await sendToBackground({ type: 'wm:editor-open', token, request });
    const editor = store.get().editor;
    if (ctx.isInvalid || editor?.id !== id || editor.surface.kind !== 'frame' || editor.surface.phase !== 'registering') return;
    if (response?.ok) this.setSurface(id, { kind: 'frame', phase: 'loading', height: 0 });
    else void this.fallback(id);
  }

  /**
   * Leave the frame: it never connected (e.g. the page's COEP blocks
   * extension frames), or it `broke`. A broken frame is replaced by a new one
   * that starts from what was typed in it; otherwise, or after
   * MAX_RECONNECTS tries, the in-page editor takes over from there.
   */
  private async fallback(id: number, broken = false): Promise<void> {
    const { store, timers } = this.deps;
    const editor = store.get().editor;
    if (editor?.id !== id || editor.surface.kind !== 'frame') return;
    timers.clear(this.connectTimer);
    this.connectTimer = undefined;
    // From now on no frame speaks for this session; what it mirrored comes back.
    const response = await sendToBackground({ type: 'wm:editor-fallback', token: editor.token });
    const current = store.get().editor;
    if (current?.id !== id || current.surface.kind !== 'frame') return;
    const draft = response?.draft ?? current.draft;
    if (broken && this.reconnects < MAX_RECONNECTS) {
      this.reconnects++;
      this.open({ ...reopened(current), draft });
      void sendToBackground({ type: 'wm:editor-close', token: current.token });
      return;
    }
    store.set({ editor: { ...current, draft, surface: { kind: 'inline' } } });
  }

  private setSurface(id: number, surface: EditorSurface): void {
    this.deps.store.set((s) => (s.editor?.id === id ? { editor: { ...s.editor, surface } } : {}));
  }

  private finishSave(session: EditorSession, note: Note): void {
    if (session.mode === 'create') this.showPin(session, note);
    this.closeSession(session.id);
    this.deps.toaster.show('Note saved');
  }

  /** Show a new note's pin on the element we know, without waiting for storage.onChanged. */
  private showPin(session: EditorSession, note: Note): void {
    const { store, resolver } = this.deps;
    if (note.pageKey !== store.get().pageKey) return;
    if (!findNote(store.get(), note.id)) store.set((s) => ({ notes: [...s.notes, note] }));
    if (!store.get().resolved.has(note.id) && session.target?.isConnected) resolver.adopt(note, session.target);
  }

  private closeSession(sessionId: number): void {
    if (this.deps.store.get().editor?.id === sessionId) this.close();
  }

  private flushDraft(): void {
    this.draftTimer = undefined;
    const pending = this.pendingDraft;
    this.pendingDraft = null;
    if (pending) void sendToBackground({ type: 'wm:editor-draft', token: pending.token, draft: pending.draft });
  }
}
