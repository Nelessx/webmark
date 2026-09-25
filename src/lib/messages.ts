import { browser, type Browser } from 'wxt/browser';
import type { DraftState, EditorEvent, EditorFrameEvent, EditorHelloResponse, EditorRequest } from './editor/protocol';
import type { NoteStatus } from './types';

/*
 * Typed message protocol between extension contexts.
 *
 *   popup / side panel / dashboard / background ──tabs.sendMessage──▶ content script   (ContentMessage)
 *   content script ──runtime.sendMessage──▶ background (+ any open extension page)    (BackgroundMessage)
 *
 * Every message type is prefixed with "wm:" so we never react to messages from
 * other code.
 */

/** A rectangle in CSS pixels relative to the viewport (getBoundingClientRect space). */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Snapshot of WebMark's state in one tab, reported by its content script. */
export interface PageState {
  pageKey: string;
  url: string;
  title: string;
  pinsVisible: boolean;
  pickerActive: boolean;
  /** Ids of notes whose element is currently found on the page (whatever their status). */
  resolvedIds: string[];
  /**
   * Ids of notes whose element could not be found on the page. Archived notes
   * are left out: they get no pin, so nothing is missing for them.
   */
  orphanedIds: string[];
  /** Notes that still need work (open or in progress): what the toolbar badge shows. */
  activeCount: number;
  /** How many of the page's notes have each status. */
  statusCounts: Record<NoteStatus, number>;
}

// ---------------------------------------------------------------------------
// Messages handled by the content script
// ---------------------------------------------------------------------------

export type ContentMessage =
  /** Enter element-picking mode. */
  | { type: 'wm:start-picker' }
  /** Open the note editor for the element the user last right-clicked. */
  | { type: 'wm:note-from-context-menu' }
  /** Show/hide pins. Omit `visible` to toggle. */
  | { type: 'wm:set-pins-visible'; visible?: boolean }
  /** Scroll to a note's element, flash it and open the note. */
  | { type: 'wm:focus-note'; noteId: string }
  | { type: 'wm:get-page-state' }
  // --- Picker control / note editor sessions (see src/lib/editor/protocol.ts) ---
  /** Leave element-picking mode without picking (e.g. Esc pressed in the side panel). */
  | { type: 'wm:stop-picker' }
  /** An event of this tab's isolated editor frame, relayed by the background. */
  | { type: 'wm:editor-event'; token: string; event: EditorEvent };

export type ContentResponse<M extends ContentMessage> = M extends { type: 'wm:get-page-state' }
  ? PageState
  : M extends { type: 'wm:focus-note' }
    ? { found: boolean }
    : { ok: boolean };

// ---------------------------------------------------------------------------
// Messages handled by the background script
// ---------------------------------------------------------------------------

export type BackgroundMessage =
  /**
   * Capture the visible tab and crop it to `rect` (viewport CSS px).
   * The content script hides its own overlay before sending this.
   */
  | { type: 'wm:capture-element'; rect: ViewportRect; devicePixelRatio: number }
  /** Content script state changed (notes loaded/resolved/edited). Used for the toolbar badge. */
  | { type: 'wm:page-state-changed'; state: PageState }
  /** Open the dashboard (options page), optionally highlighting one note. */
  | { type: 'wm:open-dashboard'; noteId?: string }
  | EditorBackgroundMessage
  // --- Storage / reveal (writes themselves travel as `wm:storage` requests, see storage.ts) ---
  /** Dashboard "Open on page": show the note in a tab that has its page (injecting WebMark if needed), or open the page. */
  | { type: 'wm:reveal-note'; pageKey: string; noteId: string };

// --- Note editor sessions (see src/lib/editor/protocol.ts) ------------------

export type EditorBackgroundMessage =
  /** Content script: register a session for the editor frame it is about to create. */
  | { type: 'wm:editor-open'; token: string; request: EditorRequest }
  /** Editor frame: claim the session named by the token in its URL. */
  | { type: 'wm:editor-hello'; token: string }
  /** Editor frame: an event for the content script of its tab. */
  | { type: 'wm:editor-emit'; token: string; event: EditorFrameEvent }
  /** Editor frame (or in-page fallback editor): unsaved values, or null once there are none. */
  | { type: 'wm:editor-draft'; token: string; draft: DraftState | null }
  /** Content script: the frame never answered, or broke; answers with what it last mirrored. */
  | { type: 'wm:editor-fallback'; token: string }
  /** Content script or editor frame: the editor closed. */
  | { type: 'wm:editor-close'; token: string }
  /** Content script, on start: a draft this tab left unsaved on the page. */
  | { type: 'wm:editor-recover'; pageKey: string };

export interface CaptureResult {
  /** JPEG data URL of the cropped element, if capture succeeded. */
  dataUrl?: string;
  error?: string;
}

export type BackgroundResponse<M extends BackgroundMessage> = M extends { type: 'wm:capture-element' }
  ? CaptureResult
  : M extends { type: 'wm:editor-hello' }
    ? EditorHelloResponse
    : M extends { type: 'wm:editor-recover' }
      ? { request?: EditorRequest }
      : M extends { type: 'wm:editor-fallback' }
        ? { ok: boolean; draft?: DraftState }
        : { ok: boolean };

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const CONTENT_TYPES = new Set<ContentMessage['type']>([
  'wm:start-picker',
  'wm:note-from-context-menu',
  'wm:set-pins-visible',
  'wm:focus-note',
  'wm:get-page-state',
  // --- Picker control / note editor sessions ---
  'wm:stop-picker',
  'wm:editor-event',
]);

// --- Note editor sessions ---
const EDITOR_TYPES = new Set<EditorBackgroundMessage['type']>([
  'wm:editor-open',
  'wm:editor-hello',
  'wm:editor-emit',
  'wm:editor-draft',
  'wm:editor-fallback',
  'wm:editor-close',
  'wm:editor-recover',
]);

const BACKGROUND_TYPES = new Set<BackgroundMessage['type']>([
  'wm:capture-element',
  'wm:page-state-changed',
  'wm:open-dashboard',
  ...EDITOR_TYPES,
  // --- Storage / reveal ---
  'wm:reveal-note',
]);

function hasType(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function isContentMessage(value: unknown): value is ContentMessage {
  return hasType(value) && CONTENT_TYPES.has(value.type as ContentMessage['type']);
}

export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  return hasType(value) && BACKGROUND_TYPES.has(value.type as BackgroundMessage['type']);
}

// --- Note editor sessions ---
export function isEditorBackgroundMessage(value: unknown): value is EditorBackgroundMessage {
  return hasType(value) && EDITOR_TYPES.has(value.type as EditorBackgroundMessage['type']);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Send a message to the content script in a tab (top frame only).
 * Resolves `undefined` when the tab has no WebMark content script
 * (restricted page, or tab opened before the extension was installed).
 */
export async function sendToTab<M extends ContentMessage>(
  tabId: number,
  message: M,
): Promise<ContentResponse<M> | undefined> {
  try {
    return (await browser.tabs.sendMessage(tabId, message, { frameId: 0 })) as ContentResponse<M>;
  } catch {
    return undefined;
  }
}

/** Send a message from a content script (or extension page) to the background. */
export async function sendToBackground<M extends BackgroundMessage>(
  message: M,
): Promise<BackgroundResponse<M> | undefined> {
  try {
    return (await browser.runtime.sendMessage(message)) as BackgroundResponse<M>;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

type Sender = Browser.runtime.MessageSender;

/**
 * Register a handler for one family of messages. The handler may be async; its
 * result is sent back as the response. Messages the guard rejects are left for
 * other listeners. Returns an unsubscribe function, which is also safe to call
 * from a content script that an extension update orphaned.
 */
export function listen<M>(
  guard: (value: unknown) => value is M,
  handler: (message: M, sender: Sender) => unknown,
): () => void {
  const listener = (message: unknown, sender: Sender, sendResponse: (response?: unknown) => void) => {
    if (!guard(message)) return false;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (result) => sendResponse(result),
        (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : String(error) }),
      );
    // Keep the channel open for the async response.
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  // `runtime` is gone once an extension update orphans a content script, which
  // is exactly when its cleanup runs; a dead listener has nothing to remove.
  return () => browser.runtime?.onMessage.removeListener(listener);
}
