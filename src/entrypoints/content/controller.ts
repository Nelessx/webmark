import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { EditorEvent, EditorFields } from '@/lib/editor/protocol';
import { sendToBackground, type PageState } from '@/lib/messages';
import { startPicker } from '@/lib/picker';
import {
  getScreenshot,
  getSettings,
  onNotesChanged,
  onSettingsChanged,
  saveSettings,
  takePendingFocus,
  type NotesChange,
} from '@/lib/storage';
import type { Note } from '@/lib/types';
import { getPageKey } from '@/lib/url';
import { ContextMenuTracker } from './contextMenu';
import { Timers } from './dom';
import { EditorController, type EditedFields, type EditorDraft } from './editorController';
import type { LayoutTracker } from './layout';
import { PageNotes, waitForElement } from './pageNotes';
import { computePageState, reportPageStateChanges } from './pageState';
import { NoteResolver } from './resolver';
import { findNote, hasPin, selectLayoutTargets, type AppStore } from './store';
import { Toaster } from './toasts';

/** What the React components may do. */
export interface UiActions {
  /** `edited`: the fields the user changed; an edit writes only those. */
  saveEditor(draft: EditorDraft, edited: EditedFields): Promise<boolean>;
  cancelEditor(): void;
  setEditorDirty(dirty: boolean): void;
  deleteNote(noteId: string): Promise<void>;
  copyMarkdown(note: Note): Promise<void>;
  /** The in-page editor's current values, kept by the background for recovery after a reload. */
  mirrorDraft(values: EditorFields, initial: EditorFields): void;
  /** The isolated editor frame of this session broke; edit in the page instead. */
  editorFrameFailed(sessionId: number): void;
  openNote(noteId: string): void;
  setHover(noteId: string | null): void;
  closeOrphanCard(): void;
  openDashboard(noteId?: string): void;
  dismissToast(id: number): void;
  loadScreenshot(noteId: string): Promise<string | undefined>;
}

export interface ControllerDeps {
  ctx: ContentScriptContext;
  store: AppStore;
  layout: LayoutTracker;
  host: HTMLElement;
  /** WebMark's (closed) shadow root: the picker looks inside it for our own controls. */
  shadowRoot: ShadowRoot;
  uiContainer: HTMLElement;
  pickerLayer: HTMLElement;
}

type PickerHandle = ReturnType<typeof startPicker>;

const FLASH_MS = 1500;
/** Let an SPA render the new route before resolving anchors against it. */
const SPA_RESOLVE_DELAY_MS = 300;
const PENDING_FOCUS_WAIT_MS = 3000;
const LOCATION_RECHECK_MS = 400;

/** Wires the in-page features together; messaging.ts and the React UI drive it. */
export class Controller implements UiActions {
  private readonly ctx: ContentScriptContext;
  private readonly store: AppStore;
  private readonly layout: LayoutTracker;
  private readonly pickerLayer: HTMLElement;
  private readonly shadowRoot: ShadowRoot;
  private readonly timers = new Timers();
  private readonly toaster: Toaster;
  private readonly resolver: NoteResolver;
  private readonly notes: PageNotes;
  private readonly editor: EditorController;
  private readonly contextMenu: ContextMenuTracker;
  private picker: PickerHandle | null = null;
  /** Resolves once the current page's notes are loaded. */
  private ready: Promise<void> = Promise.resolve();
  private flashSeq = 0;

  constructor(deps: ControllerDeps) {
    const { ctx, store, layout, host, uiContainer } = deps;
    this.ctx = ctx;
    this.store = store;
    this.layout = layout;
    this.pickerLayer = deps.pickerLayer;
    this.shadowRoot = deps.shadowRoot;
    this.toaster = new Toaster(store, this.timers);
    this.resolver = new NoteResolver(ctx, store, host, layout.schedule);
    this.notes = new PageNotes(ctx, store, this.resolver);
    this.editor = new EditorController({
      ctx,
      store,
      resolver: this.resolver,
      toaster: this.toaster,
      timers: this.timers,
      host,
      uiContainer,
    });
    this.contextMenu = new ContextMenuTracker(ctx);
  }

  start(): void {
    const { ctx, store } = this;
    const offStore = store.subscribe(() => {
      this.editor.followResolvedTarget();
      this.layout.setTargets(selectLayoutTargets(store.get()));
    });
    const offNotes = onNotesChanged((changes) => this.onNotesChanged(changes));
    const offSettings = onSettingsChanged((settings) => store.set({ settings }));
    reportPageStateChanges(ctx, store);
    // WXT's watcher (Navigation API) also fires for navigations that never
    // commit in this document (downloads, full page loads, cancelled ones), and
    // fires before pushState updates the URL. So only use it as a hint and
    // compare the real location shortly after.
    const checkSoon = () => {
      this.timers.set(() => this.checkLocation(), 0);
      this.timers.set(() => this.checkLocation(), LOCATION_RECHECK_MS);
    };
    ctx.addEventListener(window, 'wxt:locationchange', checkSoon);
    ctx.addEventListener(window, 'popstate', checkSoon);
    ctx.onInvalidated(() => {
      offStore();
      offNotes();
      offSettings();
      this.picker?.stop();
      this.picker = null;
      this.timers.clearAll();
    });

    this.ready = this.boot();
    void this.ready.then(async () => {
      await this.recoverDraft();
      await this.consumePendingFocus();
    });
  }

  // --- Message-facing API (see messaging.ts) -------------------------------

  startPicker(): boolean {
    if (this.picker?.active) return true;
    // A picked element is still being screenshotted; its editor is about to open.
    if (this.editor.busy) return false;
    if (!this.editor.release()) return false;
    this.store.set({ pickerActive: true, orphanNoteId: null, hoverNoteId: null });
    const finish = () => {
      this.picker = null;
      this.store.set({ pickerActive: false });
    };
    try {
      this.picker = startPicker({
        container: this.pickerLayer,
        shadowRoot: this.shadowRoot,
        onPick: (el) => {
          finish();
          void this.editor.openForElement(el, true);
        },
        onCancel: finish,
      });
    } catch {
      finish();
      this.toaster.show("Couldn't start the element picker", 'error');
      return false;
    }
    return true;
  }

  noteFromContextMenu(): boolean {
    const el = this.contextMenu.take();
    if (!el) return this.startPicker();
    if (this.editor.busy) return false;
    this.stopPicker();
    if (!this.editor.release()) return false;
    void this.editor.openForElement(el, true);
    return true;
  }

  /** Leave picking mode without picking (e.g. Esc in the side panel, which has the keyboard). */
  cancelPicker(): boolean {
    this.stopPicker();
    return true;
  }

  /** An event of the isolated editor frame, relayed by the background. */
  onEditorEvent(token: string, event: EditorEvent): boolean {
    return this.editor.onFrameEvent(token, event);
  }

  async setPinsVisible(visible?: boolean): Promise<boolean> {
    const settings = this.store.get().settings;
    const next = visible ?? !settings.pinsVisible;
    if (next !== settings.pinsVisible) {
      this.store.set({ settings: { ...settings, pinsVisible: next } });
      this.toaster.show(next ? 'Pins shown' : 'Pins hidden');
    }
    try {
      await saveSettings({ pinsVisible: next });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scroll to a note's element, flash it and open it; or show the "not found"
   * card. An archived note opens too when its element is found, but never gets
   * the card: it is put away, so nothing is missing.
   */
  async focusNote(noteId: string, waitMs = 0): Promise<boolean> {
    await this.ready;
    if (!findNote(this.store.get(), noteId)) await this.notes.load();
    if (!findNote(this.store.get(), noteId)) return false;

    let el = this.resolver.elementFor(noteId);
    if (!el && waitMs > 0) el = await waitForElement(this.store, this.timers, noteId, waitMs);
    if (this.ctx.isInvalid) return false;
    this.stopPicker();
    if (!el) {
      const note = findNote(this.store.get(), noteId);
      this.store.set({ orphanNoteId: note && hasPin(note) ? noteId : null, hoverNoteId: null });
      return false;
    }
    this.store.set({ orphanNoteId: null });
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.flash(el);
    this.editor.openNote(noteId);
    return true;
  }

  async getPageState(): Promise<PageState> {
    await this.ready;
    return computePageState(this.store.get());
  }

  // --- UiActions ------------------------------------------------------------

  readonly saveEditor = (draft: EditorDraft, edited: EditedFields) => this.editor.save(draft, edited);
  readonly cancelEditor = () => this.editor.close();
  readonly setEditorDirty = (dirty: boolean) => this.editor.setDirty(dirty);
  readonly deleteNote = (noteId: string) => this.editor.remove(noteId);
  readonly copyMarkdown = (note: Note) => this.editor.copyMarkdown(note);
  readonly mirrorDraft = (values: EditorFields, initial: EditorFields) => this.editor.mirrorDraft(values, initial);
  readonly editorFrameFailed = (sessionId: number) => this.editor.frameFailed(sessionId);
  readonly dismissToast = (id: number) => this.toaster.dismiss(id);
  readonly loadScreenshot = (noteId: string) => getScreenshot(noteId).catch(() => undefined);
  readonly closeOrphanCard = () => this.store.set({ orphanNoteId: null });
  readonly setHover = (noteId: string | null) => this.store.set({ hoverNoteId: noteId });

  readonly openNote = (noteId: string): void => {
    if (this.picker?.active) return;
    this.store.set({ orphanNoteId: null });
    this.editor.openNote(noteId);
  };

  readonly openDashboard = (noteId?: string): void => {
    void sendToBackground({ type: 'wm:open-dashboard', noteId });
  };

  // --- Page lifecycle -------------------------------------------------------

  private async boot(): Promise<void> {
    try {
      this.store.set({ settings: await getSettings() });
    } catch {
      // Keep defaults.
    }
    await this.notes.load();
  }

  private async consumePendingFocus(): Promise<void> {
    const pageKey = this.store.get().pageKey;
    const noteId = await takePendingFocus(pageKey).catch(() => undefined);
    if (noteId && pageKey === this.store.get().pageKey) await this.focusNote(noteId, PENDING_FOCUS_WAIT_MS);
  }

  private onNotesChanged(changes: NotesChange[]): void {
    this.notes.applyChange(changes);
    // Checked against the editor's own page: after an SPA navigation that isn't the current one.
    this.editor.onNotesChanged(changes);
  }

  /** A reload (or leaving and coming back) left an unsaved note on this page: reopen it. */
  private async recoverDraft(): Promise<void> {
    const pageKey = this.store.get().pageKey;
    const response = await sendToBackground({ type: 'wm:editor-recover', pageKey });
    if (response?.request && !this.ctx.isInvalid && pageKey === this.store.get().pageKey) {
      this.editor.restore(response.request);
    }
  }

  /** SPA navigation: if the page identity changed, reset and load the new page's notes. */
  private checkLocation(): void {
    if (this.ctx.isInvalid) return;
    const pageKey = getPageKey(location.href);
    if (pageKey === this.store.get().pageKey) return;
    this.stopPicker();
    // A note with unsaved changes stays open: it is saved to the page it was written on.
    this.editor.closeIfUntouched();
    this.notes.switchTo(pageKey);
    this.ready = this.notes.load(SPA_RESOLVE_DELAY_MS);
    void this.ready.then(() => this.consumePendingFocus());
  }

  private stopPicker(): void {
    if (!this.picker) return;
    this.picker.stop();
    this.picker = null;
    this.store.set({ pickerActive: false });
  }

  private flash(element: Element): void {
    const id = ++this.flashSeq;
    this.store.set({ flash: { id, element } });
    this.timers.set(() => {
      if (this.store.get().flash?.id === id) this.store.set({ flash: null });
    }, FLASH_MS);
  }
}
